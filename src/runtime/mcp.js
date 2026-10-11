// @ts-check
import fs from 'node:fs';
import path from 'node:path';

/** Strip // and /* *\/ comments (outside strings) and trailing commas, then JSON.parse. @param {string} src */
export function parseJsonc(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
    } else out += c;
  }
  // trailing commas: remove a comma followed (after whitespace) by } or ] — strings were copied verbatim
  // so scan again, skipping strings.
  let res = '';
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (c === '"') {
      let j = i + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === '\\' ? 2 : 1;
      res += out.slice(i, j + 1);
      i = j;
    } else if (c === ',' && /^\s*[}\]]/.test(out.slice(i + 1))) {
      continue;
    } else res += c;
  }
  return JSON.parse(res);
}

/** @param {{cwd: string, home: string}} p */
export function loadQwenMcpServers({ cwd, home }) {
  /** @type {Record<string, any>} */ const servers = {};
  /** @type {string[]} */ const warnings = [];
  for (const base of [home, cwd]) {
    const file = path.join(base, '.qwen', 'settings.json');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    try {
      const s = parseJsonc(text);
      if (s && typeof s.mcpServers === 'object' && s.mcpServers) Object.assign(servers, s.mcpServers);
    } catch {
      warnings.push(`could not parse ${file}; ignoring it`);
    }
  }
  return { servers, warnings };
}

/** @param {Record<string, any>} servers */
export function toClaudeMcpConfig(servers) {
  /** @type {Record<string, any>} */ const mcpServers = {};
  /** @type {string[]} */ const trustedNames = [];
  /** @type {string[]} */ const warnings = [];
  for (const [name, cfg] of Object.entries(servers ?? {})) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) { warnings.push(`MCP server name "${name.slice(0, 40)}" is invalid; skipped`); continue; }
    if (!cfg || typeof cfg !== 'object') { warnings.push(`MCP server ${name}: invalid config; skipped`); continue; }
    let entry;
    if (cfg.httpUrl) entry = { type: 'http', url: cfg.httpUrl, ...(cfg.headers && { headers: cfg.headers }) };
    else if (cfg.url) entry = { type: 'sse', url: cfg.url, ...(cfg.headers && { headers: cfg.headers }) };
    else if (cfg.command) {
      entry = { type: 'stdio', command: cfg.command, args: cfg.args ?? [], ...(cfg.env && { env: cfg.env }) };
      if (cfg.cwd) warnings.push(`MCP server ${name}: "cwd" is unsupported and ignored`);
    } else { warnings.push(`MCP server ${name}: unsupported transport (e.g. tcp); skipped`); continue; }
    if (cfg.includeTools || cfg.excludeTools) warnings.push(`MCP server ${name}: includeTools/excludeTools ignored`);
    mcpServers[name] = entry;
    if (cfg.trust === true) trustedNames.push(name);
  }
  return { config: { mcpServers }, trustedNames, warnings };
}
