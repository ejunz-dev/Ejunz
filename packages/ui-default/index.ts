/* eslint-disable global-require */
import {
  ContestModel, Context, Handler, ObjectId, param, PERM, PRIV, ProblemModel, Schema,
  SettingModel, SystemModel, SystemSettings, Types, UserModel,DocsModel,RepoModel
} from 'ejun';
import convert from 'schemastery-jsonschema';
import markdown from './backendlib/markdown';

class WikiHelpHandler extends Handler {
  noCheckPermView = true;

  async get() {
    this.response.template = 'wiki_help.html';
  }
}

class WikiAboutHandler extends Handler {
  noCheckPermView = true;

  async get() {
    let raw = SystemModel.get('ui-default.about') || '';
    // TODO template engine
    raw = raw.replace(/{{ name }}/g, this.domain.ui?.name || SystemModel.get('server.name')).trim();
    const lines = raw.split('\n');
    const sections = [];
    for (const line of lines) {
      if (line.startsWith('# ')) {
        const id = line.split(' ')[1];
        sections.push({
          id,
          title: line.split(id)[1].trim(),
          content: '',
        });
      } else sections[sections.length - 1].content += `${line}\n`;
    }
    this.response.template = 'about.html';
    this.response.body = { sections };
  }
}

class SetThemeHandler extends Handler {
  noCheckPermView = true;

  async get({ theme }) {
    this.checkPriv(PRIV.PRIV_USER_PROFILE);
    await UserModel.setById(this.user._id, { theme });
    this.back();
  }
}

class LegacyModeHandler extends Handler {
  noCheckPermView = true;

  @param('legacy', Types.Boolean)
  @param('nohint', Types.Boolean)
  async get(domainId: string, legacy = false, nohint = false) {
    this.session.legacy = legacy;
    this.session.nohint = nohint;
    this.back();
  }
}

class MarkdownHandler extends Handler {
  noCheckPermView = true;

  async post({ text, inline = false }) {
    this.response.body = inline
      ? markdown.renderInline(text)
      : markdown.render(text);
    this.response.type = 'text/html';
    this.response.status = 200;
  }
}

class SystemConfigSchemaHandler extends Handler {
  async get() {
    const schema = convert(Schema.intersect(SystemSettings) as any, true);
    this.response.body = schema;
  }
}

class RichMediaHandler extends Handler {
  async renderUser(domainId, payload) {
    let d = payload.domainId || domainId;
    const cur = payload.domainId ? await UserModel.getById(payload.domainId, this.user._id) : this.user;
    if (!cur.hasPerm(PERM.PERM_VIEW)) d = domainId;
    const udoc = Number.isNaN(+payload.id) ? await UserModel.getByUname(d, payload.id) : await UserModel.getById(d, +payload.id);
    return await this.renderHTML('partials/user.html', { udoc });
  }

  async renderProblem(domainId, payload) {
    const cur = payload.domainId ? await UserModel.getById(payload.domainId, this.user._id) : this.user;
    let pdoc = cur.hasPerm(PERM.PERM_VIEW | PERM.PERM_VIEW_PROBLEM)
      ? await ProblemModel.get(payload.domainId || domainId, payload.id) || ProblemModel.default
      : ProblemModel.default;
    if (pdoc.hidden && !cur.own(pdoc) && !cur.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) pdoc = ProblemModel.default;
    return await this.renderHTML('partials/problem.html', { pdoc });
  }

  async renderContest(domainId, payload) {
    const cur = payload.domainId ? await UserModel.getById(payload.domainId, this.user._id) : this.user;
    const tdoc = cur.hasPerm(PERM.PERM_VIEW | PERM.PERM_VIEW_CONTEST)
      ? await ContestModel.get(payload.domainId || domainId, new ObjectId(payload.id))
      : null;
    if (tdoc) return await this.renderHTML('partials/contest.html', { tdoc });
    return '';
  }

  async renderHomework(domainId, payload) {
    const cur = payload.domainId ? await UserModel.getById(payload.domainId, this.user._id) : this.user;
    const tdoc = cur.hasPerm(PERM.PERM_VIEW | PERM.PERM_VIEW_HOMEWORK)
      ? await ContestModel.get(payload.domainId || domainId, new ObjectId(payload.id))
      : null;
    if (tdoc) return await this.renderHTML('partials/homework.html', { tdoc });
    return '';
  }
  async renderDocs(domainId, payload) {
    const ddoc = await DocsModel.get(payload.domainId || domainId, payload.id) || DocsModel.default;
    return await this.renderHTML('partials/docs.html', { ddoc });
}
async renderRepo(domainId, payload) {
  const docId = parseInt(payload.id, 10); // 确保 `docId` 是数字
  if (isNaN(docId)) return '';

  console.log(`[RichMediaHandler.renderRepo] Fetching repo for docId=${docId}`);

  const rdoc = await RepoModel.get(domainId, docId) || RepoModel.default;
  
  console.log(`[RichMediaHandler.renderRepo] Retrieved repo:`, rdoc);

  return await this.renderHTML('partials/repo.html', { rdoc });
}




  async post({ domainId, items }) {
    const res = [];
    for (const item of items || []) {
      if (item.domainId && item.domainId === domainId) delete item.domainId;
      if (item.type === 'user') res.push(this.renderUser(domainId, item).catch(() => ''));
      else if (item.type === 'problem') res.push(this.renderProblem(domainId, item).catch(() => ''));
      else if (item.type === 'contest') res.push(this.renderContest(domainId, item).catch(() => ''));
      else if (item.type === 'homework') res.push(this.renderHomework(domainId, item).catch(() => ''));
      else if (item.type === 'docs') res.push(this.renderDocs(domainId, item).catch(() => ''));
      else if (item.type === 'repo') res.push(this.renderRepo(domainId, item).catch(() => ''));
      else res.push('');
    }
    this.response.body = await Promise.all(res);
  }
}

export function apply(ctx: Context) {
  ctx.inject(['setting'], (c) => {
    c.setting.PreferenceSetting(
      SettingModel.Setting('setting_display', 'skipAnimate', false, 'boolean', 'Skip Animation'),
      SettingModel.Setting('setting_display', 'showTimeAgo', true, 'boolean', 'Enable Time Ago'),
    );
  });
  if (process.env.EJUNZ_CLI) return;
  ctx.Route('wiki_help', '/wiki/help', WikiHelpHandler);
  ctx.Route('wiki_about', '/wiki/about', WikiAboutHandler);
  ctx.Route('set_theme', '/set_theme/:theme', SetThemeHandler);
  ctx.Route('set_legacy', '/legacy', LegacyModeHandler);
  ctx.Route('markdown', '/markdown', MarkdownHandler);
  ctx.Route('config_schema', '/manage/config/schema.json', SystemConfigSchemaHandler, PRIV.PRIV_EDIT_SYSTEM);
  ctx.Route('media', '/media', RichMediaHandler);
  ctx.on('handler/after/DiscussionRaw', async (that) => {
    if (that.args.render && that.response.type === 'text/markdown') {
      that.response.type = 'text/html';
      that.response.body = await markdown.render(that.response.body);
    }
  });
  ctx.on('handler/after', async (that) => {
    that.UiContext.SWConfig = {
      preload: SystemModel.get('ui-default.preload'),
      hosts: [
        `http://${that.request.host}`,
        `https://${that.request.host}`,
        SystemModel.get('server.url'),
        SystemModel.get('server.cdn'),
      ],
      assets: ((SystemModel.get('ui-default.assets') || '').split(',')).filter((i) => i) || [],
      domains: SystemModel.get('ui-default.domains') || [],
    };
  });
  ctx.plugin(require('./backendlib/template'));
  ctx.plugin(require('./backendlib/builder'));
}
