import * as status from '@ejunz/utils/lib/status';
import { findFileSync } from '@ejunz/utils/lib/utils';
import {
  avatar, buildContent, Context,
  fs, PERM, PRIV, STATUS, yaml,
} from 'ejun';
import jsesc from 'jsesc';
import nunjucks from 'nunjucks';
import path from 'path';
import markdown from './markdown';
import { ensureTag, xss } from './markdown-it-xss';
import * as misc from './misc';
console.log("Starting the script...");
console.log("Checking global.Ejunz:", global.Ejunz);
console.log("Checking global.Ejunz.ui.template:", global.Ejunz?.ui?.template);

const argv = require('cac')().parse();

let { template } = argv.options;
if (!template || typeof template !== 'string') template = findFileSync('@ejunz/ui-default/templates');
else template = findFileSync(template);

class Loader extends nunjucks.Loader {
  getSource(name) {
    console.log("Attempting to load template:", name);
    
    const src = global.Ejunz.ui.template?.[name];
    console.log("Global template source:", src ? "Found" : "Not Found");

    let fullpath = null;
    const p = path.resolve(template, name);
    if (fs.existsSync(p)) {
      fullpath = p;
      console.log("Template found at path:", fullpath);
    } else {
      console.log("Template not found at path:", p);
    }

    if (fullpath) {
      return {
        src: fs.readFileSync(fullpath, 'utf-8'),
        path: fullpath,
        noCache: true,
      };
    } else if (src) {
      return {
        src,
        path: name,
        noCache: true,
      };
    } else {
      throw new Error(`Cannot get template ${name}`);
    }
  }
}

const replacer = (k, v) => {
  if (k.startsWith('_') && k !== '_id') return undefined;
  if (typeof v === 'bigint') return `BigInt::${v.toString()}`;
  return v;
};

class Nunjucks extends nunjucks.Environment {
  constructor() {
    super(new Loader(), { autoescape: true, trimBlocks: true });
    this.addFilter('await', async (promise, callback) => {
      try {
        const result = await promise;
        callback(null, result);
      } catch (error) {
        callback(error);
      }
    }, true);
    this.addFilter('json', (self) => (self ? JSON.stringify(self, replacer) : ''));
    this.addFilter('parseYaml', (self) => yaml.load(self));
    this.addFilter('dumpYaml', (self) => yaml.dump(self));
    this.addFilter('assign', (self, data) => Object.assign(self, data));
    this.addFilter('markdown', (self) => ensureTag(markdown.render(self)));
    this.addFilter('markdownInline', (self) => ensureTag(markdown.renderInline(self)));
    this.addFilter('ansi', (self) => misc.ansiToHtml(self));
    this.addFilter('base64_encode', (s) => Buffer.from(s).toString('base64'));
    this.addFilter('base64_decode', (s) => Buffer.from(s, 'base64').toString());
    this.addFilter('jsesc', (self) => jsesc(self, { isScriptContext: true }));
    this.addFilter('bitand', (self, val) => self & val);
    this.addFilter('toString', (self) => (typeof self === 'string' ? self : JSON.stringify(self, replacer)));
    this.addFilter('content', (content, language, html) => {
      let s = '';
      try {
        s = JSON.parse(content);
      } catch {
        s = content;
      }
      if (typeof s === 'object' && !(s instanceof Array)) {
        const langs = Object.keys(s);
        const f = langs.filter((i) => i.startsWith(language));
        if (s[language]) s = s[language];
        else if (f.length) s = s[f[0]];
        else s = s[langs[0]];
      }
      if (s instanceof Array) s = buildContent(s, html ? 'html' : 'markdown', (str) => str.translate(language));
      return ensureTag(html ? xss.process(s) : markdown.render(s));
    });
    this.addFilter('contentLang', (content) => {
      let s = '';
      try {
        s = JSON.parse(content);
      } catch {
        s = content;
      }
      if (typeof s === 'object' && !(s instanceof Array)) {
        return Object.keys(s);
      }
      return [];
    });
    this.addFilter('log', (self) => {
      console.log(self);
      return self;
    });
  }
}

// Custom member lookup for nunjucks
nunjucks.runtime.memberLookup = function memberLookup(obj, val) {
  if ((obj || {})._original) obj = obj._original;
  if (obj === undefined || obj === null) return undefined;
  if (typeof obj[val] === 'function') {
    const fn = function (...args) {
      return obj[val].call(obj, ...args);
    };
    fn._original = obj[val];
    return fn;
  }
  return obj[val];
};

const env = new Nunjucks();
env.addGlobal('eval', eval);
env.addGlobal('Date', Date);
env.addGlobal('Object', Object);
env.addGlobal('String', String);
env.addGlobal('Array', Array);
env.addGlobal('Math', Math);
env.addGlobal('process', process);
env.addGlobal('global', global);
env.addGlobal('typeof', (o) => typeof o);
env.addGlobal('instanceof', (a, b) => a instanceof b);
env.addGlobal('paginate', misc.paginate);
env.addGlobal('size', misc.size);
env.addGlobal('utils', { status });
env.addGlobal('avatarUrl', avatar);
env.addGlobal('formatSeconds', misc.formatSeconds);
env.addGlobal('lib', global.Ejunz.lib);
env.addGlobal('model', global.Ejunz.model);
env.addGlobal('ui', global.Ejunz.ui);
env.addGlobal('isIE', (str) => {
  if (!str) return false;
  if (['MSIE', 'rv:11.0'].some((i) => str.includes(i))) return true;
  if (str.includes('Chrome/') && +str.split('Chrome/')[1].split('.')[0] < 60) return true;
  return false;
});
env.addGlobal('set', (obj, key, val) => {
  if (val !== undefined) obj[key] = val;
  else Object.assign(obj, key);
  return '';
});
env.addGlobal('findSubModule', (prefix) => Object.keys(global.Ejunz.ui.template).filter((n) => n.startsWith(prefix)));
env.addGlobal('templateExists', (name) => !!global.Ejunz.ui.template[name]);

const render = (name, state) => new Promise((resolve, reject) => {
  env.render(name, {
    page_name: name.split('.')[0],
    ...state,
    title: state.title || 'Default Title',
    message: state.message || 'Default Message',
  }, (err, res) => {
    if (err) reject(err);
    else resolve(res);
  });
});

export const inject = ['server'];
export async function apply(ctx) {
  ctx.server.registerRenderer('html', render);
  ctx.server.registerRenderer('yaml', render);
  ctx.server.registerRenderer('md', render);
}
