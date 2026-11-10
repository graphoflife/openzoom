import { h } from './dom.js';
import { t } from '../i18n.js';

const MAX_ROWS = 60;

/** Legend in the viewport for the element state's legend (smart view colours, clash focus). */
export class Legend {
  constructor(app, host) {
    this.app = app;
    this.el = h('div.legend');
    host.appendChild(this.el);
    app.state.addEventListener('change', () => this.render());
  }

  render() {
    const { app, el } = this;
    el.innerHTML = '';
    const legend = app.state.legend;
    if (!legend || app.settings.get('legend') === false) { el.classList.remove('show'); return; }
    const entries = legend.entries;
    el.classList.add('show');
    el.appendChild(h('div.legend-title', legend.title || t('sv.legend')));
    const list = h('div.legend-list');
    for (const entry of entries.slice(0, MAX_ROWS)) {
      const row = h('div.legend-row', { title: entry.label },
        h('span.swatch', { style: { background: `rgb(${entry.color.join(',')})` } }),
        h('span.legend-label', entry.label),
        h('span.legend-count', String(entry.count)),
        entry.takeoff !== null && entry.takeoff !== undefined ? h('span.legend-takeoff', app.fmtNum(entry.takeoff, 2)) : null);
      row.addEventListener('click', (ev) => app.state.select(entry.gids, ev.ctrlKey ? 'add' : 'replace'));
      list.appendChild(row);
    }
    if (entries.length > MAX_ROWS) list.appendChild(h('div.muted', `… ${entries.length - MAX_ROWS}`));
    el.appendChild(list);
  }
}
