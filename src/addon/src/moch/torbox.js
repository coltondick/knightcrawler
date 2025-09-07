// src/addon/src/moch/torbox.js
import axios from 'axios';
import { cacheAvailabilityResults, getCachedAvailabilityResults } from '../lib/cache.js';
import { isVideo } from '../lib/extension.js';
import { getMagnetLink } from '../lib/magnetHelper.js';
import { Type } from '../lib/types.js';
import { chunkArray, BadTokenError, AccessDeniedError } from './mochHelper.js';
import StaticResponse from './static.js';

const KEY = 'torbox';
const API = 'https://api.torbox.app/v1/api';
const CATALOG_MAX_PAGE = 1; // keep it consistent with other providers

export async function getCachedStreams(streams, apiKey) {
  const hashes = streams.map(s => s.infohash);
  const available = await _checkCached(hashes, apiKey);
  return streams.reduce((acc, stream) => {
    const entry = available?.[stream.infohash];
    const cached = !!(entry && entry.files && entry.files.length);
    acc[stream.infohash] = {
      // This url is later parsed by moch.js -> resolve(parameters)
      url: `${apiKey}/${stream.infohash}/null/${stream.fileIdx}`,
      cached
    };
    return acc;
  }, {});
}

export async function resolve(parameters) {
  const { apiKey, infohash, fileIndex, ip } = parameters;
  try {
    // 1) Make sure the torrent exists in account (idempotent)
    const magnet = getMagnetLink(infohash);
    const torrentId = await _createOrFindTorrent(apiKey, infohash, magnet);

    // 2) Map our desired file index → TorBox file id
    const { fileId } = await _getFileIdForIndex(apiKey, torrentId, fileIndex);

    // 3) Ask for a direct link
    const url = await _requestDownloadLink(apiKey, torrentId, fileId, ip);
    return url;
  } catch (err) {
    if (err === BadTokenError) return StaticResponse.FAILED_ACCESS;
    if (err === AccessDeniedError) return StaticResponse.FAILED_ACCESS;
    return StaticResponse.FAILED_UNEXPECTED;
  }
}

export async function getCatalog(apiKey, offset) {
  if (offset > 0) return [];
  // “Downloads” + each ready torrent, similar to RD
  const downloadsMeta = {
    id: `${KEY}:Downloads`,
    type: Type.OTHER,
    name: 'Downloads'
  };
  const torrents = await _myList(apiKey).then(t => Array.isArray(t) ? t : []);
  const metas = torrents
    .filter(t => t && (t.status?.toLowerCase?.() === 'finished' || t.status?.toLowerCase?.() === 'ready' || t.files?.length))
    .map(t => ({
      id: `${KEY}:${t.id}`,
      type: Type.OTHER,
      name: t.name || t.filename || t.hash?.slice(0, 12) || 'Torrent'
    }));
  return [downloadsMeta, ...metas];
}

export async function getItemMeta(itemId, apiKey /*, ip */) {
  // Downloads “folder”
  if (itemId === 'Downloads') {
    const list = await _myList(apiKey);
    const videos = list.flatMap(t =>
      (t.files || [])
        .filter(f => isVideo(f.name))
        .map((f, idx) => ({
          id: `${KEY}:${t.id}:${f.id ?? (idx + 1)}`,
          title: `${t.name}/${f.name}`,
          released: new Date(new Date(t.added || Date.now()).getTime() - idx).toISOString(),
          streams: [{ url: `${apiKey}/${(t.hash || '').toLowerCase()}/null/${idx}` }]
        })));
    return { id: `${KEY}:Downloads`, type: Type.OTHER, name: 'Downloads', videos };
  }

  // Treat other itemIds as TorBox torrent ids
  const torrent = await _myList(apiKey, itemId); // single object
  const files = (torrent.files || []).filter(f => isVideo(f.name));
  return {
    id: `${KEY}:${torrent.id}`,
    type: Type.OTHER,
    name: torrent.name || torrent.filename || torrent.hash?.slice(0, 12) || 'Torrent',
    infohash: (torrent.hash || '').toLowerCase(),
    videos: files.map((f, idx) => ({
      id: `${KEY}:${torrent.id}:${f.id ?? (idx + 1)}`,
      title: f.name,
      released: new Date(new Date(torrent.added || Date.now()).getTime() - idx).toISOString(),
      streams: [{ url: `${apiKey}/${(torrent.hash || '').toLowerCase()}/null/${idx}` }]
    }))
  };
}

/* ------------------ internals ------------------ */

async function _checkCached(hashes, apiKey, maxChunkSize = 100) {
  const cached = await getCachedAvailabilityResults(hashes);
  const missing = hashes.filter(h => !cached[h]);
  if (!missing.length) return cached;

  const chunks = chunkArray(missing, maxChunkSize);
  const map = {};
  for (const chunk of chunks) {
    const q = chunk.map(h => `hash=${encodeURIComponent(h)}`).join('&');
    const { data } = await axios.get(`${API}/torrents/checkcached?${q}&format=object&list_files=true`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 10000
    }).catch(_rethrowAuth);
    Object.assign(map, data?.data || {});
  }
  return cacheAvailabilityResults(map);
}

async function _createOrFindTorrent(apiKey, infohash, magnet) {
  // Try to create (idempotent enough; duplicates will error)
  const created = await axios.post(`${API}/torrents/createtorrent`, { magnet_link: magnet }, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 15000
  }).catch(err => {
    if (err?.response?.status === 400 || err?.response?.status === 409) return null;
    _rethrowAuth(err);
  });

  if (created?.data?.data?.id) return created.data.data.id;

  // Fallback: locate by hash in my list
  const list = await _myList(apiKey);
  const found = list.find(t => (t.hash || '').toLowerCase() === infohash.toLowerCase());
  if (!found) throw new Error('Torrent not found/created');
  return found.id;
}

async function _getFileIdForIndex(apiKey, torrentId, index) {
  const torrent = await _myList(apiKey, torrentId);
  const vids = (torrent.files || []).filter(f => isVideo(f.name));
  const file = vids[index];
  if (!file) throw new Error('File index out of range');
  return { fileId: (file.id != null) ? file.id : (index + 1) };
}

async function _requestDownloadLink(apiKey, torrentId, fileId, ip) {
  // TorBox expects the API key as a token query param for requestdl (not Bearer)
  const url = `${API}/torrents/requestdl?token=${encodeURIComponent(apiKey)}&torrent_id=${encodeURIComponent(torrentId)}&file_id=${encodeURIComponent(fileId)}&redirect=false${ip ? `&user_ip=${encodeURIComponent(ip)}` : ''}`;
  const { data } = await axios.get(url, { timeout: 10000 });
  const link = data?.data?.download || data?.data?.url;
  if (!link) throw new Error('No download link');
  return link;
}

async function _myList(apiKey, id /* optional */) {
  const url = id ? `${API}/torrents/mylist?id=${encodeURIComponent(id)}` : `${API}/torrents/mylist`;
  const { data } = await axios.get(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 10000
  }).catch(_rethrowAuth);
  // If id was provided, TorBox returns single torrent in data, normalize to object
  if (id) return (data?.data && (Array.isArray(data.data) ? data.data[0] : data.data)) || {};
  return data?.data || [];
}

function _rethrowAuth(err) {
  const status = err?.response?.status;
  if (status === 401 || status === 403) throw BadTokenError;
  if (status === 402) throw AccessDeniedError;
  throw err;
}

export default { KEY };
