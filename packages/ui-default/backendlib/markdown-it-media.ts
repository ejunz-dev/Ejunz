/* eslint-disable max-len */
/* eslint-disable prefer-destructuring */

import type MarkdownIt from 'markdown-it';
import { v4 as uuid } from 'uuid';

const allowFullScreen = ' webkitallowfullscreen mozallowfullscreen allowfullscreen';

const IMPORT_REGEX = /@\[(.*?)\]\((.*?)\)/;

const ytRegex = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
function youtubeParser(url: string) {
  const match = url.match(ytRegex);
  return match && match[7].length === 11 ? match[7] : url;
}
const vimeoRegex = /https?:\/\/(?:www\.|player\.)?vimeo.com\/(?:channels\/(?:\w+\/)?|groups\/([^/]*)\/videos\/|album\/(\d+)\/video\/|)(\d+)(?:$|\/|\?)/;
function vimeoParser(url: string) {
  const match = url.match(vimeoRegex);
  return match && typeof match[3] === 'string' ? match[3] : url;
}
const vineRegex = /^http(?:s?):\/\/(?:www\.)?vine\.co\/v\/([a-zA-Z0-9]{1,13}).*/;
function vineParser(url: string) {
  const match = url.match(vineRegex);
  return match && match[1].length === 11 ? match[1] : url;
}
const preziRegex = /^https:\/\/prezi.com\/(.[^/]+)/;
function preziParser(url: string) {
  const match = url.match(preziRegex);
  return match ? match[1] : url;
}
const EMBED_REGEX = /@\[([a-zA-Z].+?)]\((.*?)[)]/im;
function extractVideoParameters(url: string) {
  const parameterMap = new Map();
  const params = url.replace(/&amp;/gi, '&').split(/[#?&]/);
  if (params.length > 1) {
    for (let i = 1; i < params.length; i += 1) {
      const keyValue = params[i].split('=');
      if (keyValue.length > 1) parameterMap.set(keyValue[0], keyValue[1]);
    }
  }
  return parameterMap;
}
function resourceUrl(service: string, src: string, url: string) {
  if (service === 'youtube') {
    const parameters = extractVideoParameters(url);
    const timeParameter = parameters.get('t');
    if (timeParameter !== undefined) {
      let startTime = 0;
      const timeParts = timeParameter.match(/[0-9]+/g);
      let j = 0;
      while (timeParts.length > 0) {
        startTime += Number(timeParts.pop()) * (60 ** j);
        j += 1;
      }
      parameters.set('start', startTime);
      parameters.delete('t');
    }
    parameters.delete('v');
    parameters.delete('feature');
    parameters.delete('origin');
    const parameterArray = Array.from(parameters, (p) => p.join('='));
    const parameterPos = src.indexOf('?');
    let finalUrl = `https://www.youtube.com/embed/${parameterPos > -1 ? src.substring(0, parameterPos) : src}`;
    if (parameterArray.length > 0) finalUrl += `?${parameterArray.join('&')}`;
    return finalUrl;
  }
  if (service === 'bilibili') {
    if (src.startsWith('http')) src = src.split('/').pop();
    if (src.toLowerCase().startsWith('av')) src = src.toLowerCase().split('av')[1];
    src = src.split('?')[0];
    return `//player.bilibili.com/player.html?${src.startsWith('BV') ? 'bvid' : 'aid'}=${src}&autoplay=0`;
  }
  if (service === 'msoffice') return `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(src)}`;
  if (service === 'youku') return `https://player.youku.com/embed/${src}`;
  if (service === 'vimeo') return `https://player.vimeo.com/video/${src}`;
  if (service === 'vine') return `https://vine.co/v/${src}/embed/simple`;
  if (service === 'prezi') {
    return `https://prezi.com/embed/${src}/?bgcolor=ffffff&amp;lock_to_path=0&amp;autoplay=0&amp;autohide_ctrls=0&amp;`
      + 'landing_data=bHVZZmNaNDBIWnNjdEVENDRhZDFNZGNIUE43MHdLNWpsdFJLb2ZHanI5N1lQVHkxSHFxazZ0UUNCRHloSXZROHh3PT0&amp;'
      + 'landing_sign=1kD6c0N6aYpMUS0wxnQjxzSqZlEB8qNFdxtdjYhwSuI';
  }
  return src;
}
function getResourceTitle(resourceUrl: string) {
  if (typeof window !== 'undefined' && window.UiContext && window.UiContext.resources) {
    console.log("🔍 Checking UiContext.resources:", window.UiContext.resources);
    console.log("🔍 Searching title for:", resourceUrl);

    const decodedUrl = decodeURIComponent(resourceUrl);

    for (const [title, url] of Object.entries(window.UiContext.resources)) {
      if (decodeURIComponent(url) === decodedUrl) {
        console.log(`✅ Found title: ${title} for ${decodedUrl}`);
        return title; 
      }
    }
  }

  console.warn(`❌ Title not found for: ${resourceUrl}`);
  return resourceUrl; 
}

declare module 'ejun' {
  interface ModuleInterfaces {
    richmedia: {
      get: (src: string) => string | null;
    }
  }
}
const domainfileRegex = /^\/d\/[A-Za-z0-9\/%.-]+$/;
const repofileRegex = /^\/repo\/[A-Za-z0-9]+\/file\/[A-Za-z0-9\/%.-]+$/;

function parseFilePath(filePath: string, hostname: string, type: 'domainfile' | 'repofile') {
  const decodedPath = decodeURIComponent(filePath).replace(/\/{2,}/g, '/'); // Decode and sanitize path

  if (type === 'domainfile' && domainfileRegex.test(decodedPath)) {
    return `${hostname}${decodedPath}`;
  }

  if (type === 'repofile' && repofileRegex.test(decodedPath)) {
    return `${hostname}${decodedPath}`;
  }

  throw new Error(`Invalid ${type} path: ${filePath}`);
}


export function Media(md: MarkdownIt, getHostname?: () => string) {
  const supported = ['youtube', 'vimeo', 'vine', 'prezi', 'bilibili', 'youku', 'msoffice', 'domainfile', 'repofile','import'];
  md.inline.ruler.before('emphasis', 'import_resource', (state, silent) => {
    const match = IMPORT_REGEX.exec(state.src.slice(state.pos));
    if (!match) return false;

    const [fullMatch, displayText, resourceUrl] = match;

    if (!silent) {
      const token = state.push('import_resource', '', 0);
      token.content = displayText;
      token.attrSet('resourceUrl', resourceUrl);
    }

    state.pos += fullMatch.length;
    return true;
});

md.renderer.rules.import_resource = function (tokens, idx) {
  const token = tokens[idx];
  const resourceUrl = token.attrGet('resourceUrl') || '';
  const resourceTitle = getResourceTitle(resourceUrl) || resourceUrl; // ✅ 直接查找 title

  console.log(`🎯 Rendering import: ${resourceTitle} (${resourceUrl})`);
  return `<a href="${resourceUrl}" class="resource-link">@${resourceTitle}</a>`;
};




  
  md.renderer.rules.video = function tokenizeReturn(tokens, idx) {
    let src = md.utils.escapeHtml(tokens[idx].attrGet('src'));
    const service = md.utils.escapeHtml(tokens[idx].attrGet('service')).toLowerCase();

    if (Ejunz?.module?.richmedia?.[service]) {
      const result = Ejunz.module.richmedia[service].get(src);
      if (result) return result;
    }
  if (service === 'import') {
      const resourceTitle = getResourceTitle(src) || src;
      return `<a href="${src}" class="resource-link">@${resourceTitle}</a>`;
  }
  
 // Handle domainfile
 if (service === 'domainfile' && domainfileRegex.test(src)) {
  const hostname = typeof getHostname === 'function' ? getHostname() : 'https://beta.ejunz.com';
  src = parseFilePath(src, hostname, 'domainfile');
  return `<a href="${src}" target="_blank">${src}</a>`;
}

// Handle repofile
if (service === 'repofile' && repofileRegex.test(src)) {
  const hostname = typeof getHostname === 'function' ? getHostname() : 'https://beta.ejunz.com';
  src = parseFilePath(src, hostname, 'repofile');
  return `<img src="${src}" alt="${src}" style="max-width: 100%;">`;
}

if (service === 'pdf') {
  if (src.startsWith('file://') || src.startsWith('./')) src += src.includes('?') ? '&noDisposition=1' : '?noDisposition=1';
  return `\
    <object classid="clsid:${uuid().toUpperCase()}">
      <param name="SRC" value="${src}" >
      <embed width="100%" style="min-height: 100vh;border: none;" fullscreen="yes" src="${src}">
        <noembed></noembed>
      </embed>
    </object>`;
}

if (['url', 'video'].includes(service)) {
  return `\
    <video width="100%" controls>
      <source src="${src}" type="${src.endsWith('ogg') ? 'video/ogg' : 'video/mp4'}">
      Your browser doesn't support video tag.
    </video>`;
}

if (supported.includes(service)) {
  return `\
  <iframe class="embed-responsive-item ${service}-player" type="text/html" \
    width="100%" style="min-height: 500px" ${allowFullScreen} \
    src="${resourceUrl(service, src, tokens[idx].attrGet('url'))}"
    scrolling="no" border="0" frameborder="no" framespacing="0"></iframe>`;
}
return `<div data-${service}>${md.utils.escapeHtml(src)}</div>`;
};

md.inline.ruler.before('emphasis', 'video', (state, silent) => {
const oldPos = state.pos;

if (state.src.charCodeAt(oldPos) !== 0x40 /* @ */
  || state.src.charCodeAt(oldPos + 1) !== 0x5B /* [ */) {
  return false;
}

const match = EMBED_REGEX.exec(state.src.slice(state.pos, state.src.length));
if (!match || match.length < 3) {
  console.warn('Markdown inline rule did not match:', state.src);
  return false;
}

let [, service, src] = match;
service = service.toLowerCase();

if (service === 'youtube') src = youtubeParser(src);
else if (service === 'vimeo') src = vimeoParser(src);
else if (service === 'vine') src = vineParser(src);
else if (service === 'prezi') src = preziParser(src);
else if (service === 'domainfile' && domainfileRegex.test(src)) {
  const hostname = typeof getHostname === 'function' ? getHostname() : 'https://beta.ejunz.com';
  src = parseFilePath(src, hostname, 'domainfile');
} else if (service === 'repofile' && repofileRegex.test(src)) {
  const hostname = typeof getHostname === 'function' ? getHostname() : 'https://beta.ejunz.com';
  src = parseFilePath(src, hostname, 'repofile');
}

if (src === ')') src = '';

const serviceStart = oldPos + 2;

if (!silent) {
  state.pos = serviceStart;
  const newState = new state.md.inline.State(service, state.md, state.env, []);
  newState.md.inline.tokenize(newState);
  const token = state.push('video', '', undefined);
  token.attrPush(['src', src]);
  token.attrPush(['service', service]);
  token.attrPush(['url', match[2]]);
  token.level = state.level;
}

state.pos += state.src.indexOf(')', state.pos);
return true;
});
}