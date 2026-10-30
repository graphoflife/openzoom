import { h, clear, showMenu, confirmDialog, dialog } from './dom.js';
import { icon } from './icons.js';
import { t, getLanguage } from '../i18n.js';
import { newGuid } from '../core/bcf.js';

const STATUS = ['Open', 'Active', 'Resolved', 'Closed'];
const TYPES = ['Issue', 'Clash', 'Request', 'Remark', 'Fault', 'Inquiry'];
const PRIORITIES = ['Low', 'Normal', 'High', 'Critical'];

/** BCF issue list and editor. */
export class IssuesPanel {
  constructor(app, host) {
    this.app = app;
    this.mgr = app.issues;
    this.filter = '';
    const tb = (ic, title, fn) => h('button.icon-btn', { title, html: icon(ic, 16), on: { click: fn } });
    host.append(
      h('div.panel-head',
        tb('plus', t('issue.new'), () => app.createIssue()),
        tb('import', t('issue.import'), () => app.importBcf()),
        h('button.icon-btn', {
          title: t('cmd.exportBcf'), html: `${icon('export', 16)}<span class="caret">▾</span>`,
          on: { pointerdown: (e) => { e.stopPropagation(); showMenu([{ label: t('issue.export21'), run: () => app.exportBcf('2.1') }, { label: t('issue.export30'), run: () => app.exportBcf('3.0') }], e.clientX, e.clientY); } },
        }),
        h('span.flex'),
        h('input.input.small', { type: 'search', placeholder: t('tree.filter'), on: { input: (e) => { this.filter = e.target.value.toLowerCase(); this.render(); } } })),
      this.listEl = h('div.issue-list'),
      this.detailEl = h('div.issue-detail'));
    this.mgr.addEventListener('change', () => this.render());
    this.render();
  }

  render() {
    clear(this.listEl);
    const list = this.mgr.issues.filter((i) => !this.filter || `${i.title} ${i.description} ${i.assignedTo} ${(i.labels || []).join(' ')}`.toLowerCase().includes(this.filter));
    if (!list.length) this.listEl.appendChild(h('div.empty', t('issue.none')));
    for (const issue of list) {
      const snap = issue.viewpoints?.[0]?.snapshot;
      const card = h('div.issue-card', { class: `issue-card${issue === this.mgr.selected ? ' selected' : ''}` },
        snap ? h('img.thumb', { src: snap, alt: '' }) : h('div.thumb'),
        h('div.issue-info',
          h('div.issue-title', `${issue.index ? `#${issue.index} ` : ''}${issue.title}`),
          h('div.issue-meta',
            h('span.badge', { class: `badge is-${(issue.status || '').toLowerCase()}` }, issue.status),
            issue.priority ? h('span.badge.prio', issue.priority) : null,
            h('span.muted', `${issue.type || ''}${issue.assignedTo ? ` · ${issue.assignedTo}` : ''}`)),
          h('div.muted.small', `${issue.creationAuthor || ''} · ${fmtDate(issue.creationDate)}`)));
      card.addEventListener('click', () => this.select(issue));
      this.listEl.appendChild(card);
    }
    this.renderDetail();
  }

  select(issue, show = true) {
    this.mgr.selected = issue;
    if (show) this.mgr.showViewpoint(issue.viewpoints?.[0]);
    this.render();
  }

  renderDetail() {
    clear(this.detailEl);
    const issue = this.mgr.selected;
    if (!issue || !this.mgr.issues.includes(issue)) return;
    const touch = () => { this.mgr.touch(issue); };
    const input = (field, attrs = {}) => {
      const el = h('input.input.small', { value: issue[field] || '', ...attrs });
      el.addEventListener('change', () => { issue[field] = el.value; touch(); });
      return el;
    };
    const select = (field, options) => {
      const opts = options.includes(issue[field]) || !issue[field] ? options : [issue[field], ...options];
      const el = h('select.input.small', ...opts.map((o) => h('option', { value: o, selected: o === issue[field] }, o)));
      el.addEventListener('change', () => { issue[field] = el.value; touch(); });
      return el;
    };
    const desc = h('textarea.input', { rows: 3 }, issue.description || '');
    desc.addEventListener('change', () => { issue.description = desc.value; touch(); });
    const labels = h('input.input.small', { value: (issue.labels || []).join(', ') });
    labels.addEventListener('change', () => { issue.labels = labels.value.split(',').map((s) => s.trim()).filter(Boolean); touch(); });
    const due = h('input.input.small', { type: 'date', value: (issue.dueDate || '').slice(0, 10) });
    due.addEventListener('change', () => { issue.dueDate = due.value ? new Date(due.value).toISOString() : ''; touch(); });
    const vps = h('div.vp-strip', ...(issue.viewpoints || []).map((vp, k) => {
      const im = vp.snapshot ? h('img.vp-thumb', { src: vp.snapshot, title: `Viewpoint ${k + 1}` }) : h('div.vp-thumb', `${k + 1}`);
      im.addEventListener('click', () => this.mgr.showViewpoint(vp));
      im.addEventListener('dblclick', () => vp.snapshot && dialog({ title: issue.title, body: h('img', { src: vp.snapshot, style: { maxWidth: '100%' } }), width: 900 }));
      return im;
    }));
    const comments = h('div.comments', ...(issue.comments || []).map((c) => h('div.comment',
      h('div.comment-head', h('b', c.author || ''), h('span.muted', ` ${fmtDate(c.date)}`)),
      h('div', c.comment))));
    const newComment = h('textarea.input', { rows: 2, placeholder: t('issue.addComment') });
    this.detailEl.append(
      h('div.form.compact',
        h('label', t('issue.title'), input('title')),
        h('div.form-row.three', h('label', t('issue.status'), select('status', STATUS)), h('label', t('issue.type'), select('type', TYPES)), h('label', t('issue.priority'), select('priority', PRIORITIES))),
        h('div.form-row.three', h('label', t('issue.assigned'), input('assignedTo')), h('label', t('issue.due'), due), h('label', t('issue.labels'), labels)),
        h('label', t('issue.description'), desc),
        vps,
        h('div.row',
          h('button.btn.small', { on: { click: () => this.mgr.showViewpoint(issue.viewpoints?.[0]) } }, t('issue.show')),
          h('button.btn.small', { on: { click: () => { issue.viewpoints = [this.mgr.captureViewpoint(), ...(issue.viewpoints || []).slice(1)]; touch(); } } }, t('issue.updateView')),
          h('button.btn.small', { on: { click: () => { (issue.viewpoints ||= []).push(this.mgr.captureViewpoint()); touch(); } } }, '+ Viewpoint'),
          h('span.flex'),
          h('button.btn.small.danger', { on: { click: async () => { if (await confirmDialog(t('issue.delete'), issue.title)) this.mgr.remove(issue); } } }, t('issue.delete'))),
        h('div.form-label', t('issue.comments')),
        comments,
        newComment,
        h('div.row', h('span.flex'), h('button.btn.small.primary', {
          on: {
            click: () => {
              if (!newComment.value.trim()) return;
              (issue.comments ||= []).push({ guid: newGuid(), date: new Date().toISOString(), author: this.mgr.author(), comment: newComment.value.trim(), modifiedDate: '', modifiedAuthor: '', viewpointGuid: issue.viewpoints?.[0]?.guid || null });
              touch();
            },
          },
        }, t('issue.addComment')))));
  }
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(getLanguage() === 'de' ? 'de-DE' : 'en-US', { dateStyle: 'short', timeStyle: 'short' });
}
