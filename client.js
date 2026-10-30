window.__ModuleLoader__.load({
  id: 'dsh-memory-nebula',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    function NebulaIcon({ size = 20, active = false }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', 'aria-hidden': true,
        style: { display: 'block', color: active ? '#ffd28a' : 'currentColor' },
      },
        h('circle', { cx: 12, cy: 12, r: 8.2, stroke: 'currentColor', strokeOpacity: active ? 0.9 : 0.5, strokeWidth: 1.1 }),
        h('ellipse', { cx: 12, cy: 12, rx: 8.2, ry: 3.1, stroke: 'currentColor', strokeOpacity: 0.35, strokeWidth: 0.7, transform: 'rotate(-24 12 12)' }),
        h('circle', { cx: 12, cy: 12, r: 1.7, fill: '#ffd28a' }),
        h('circle', { cx: 7.1, cy: 9.2, r: 0.95, fill: '#79dbe8' }),
        h('circle', { cx: 16.7, cy: 14.9, r: 0.95, fill: '#7fe6b6' }),
        h('circle', { cx: 15.7, cy: 7.8, r: 0.8, fill: '#c4a2ff' }));
    }

    function NebulaPage() {
      return h('div', {
        style: { height: '100%', minHeight: 0, background: '#04060d' },
      }, h('iframe', {
        src: '/memory-nebula/view',
        title: '记忆戴森球',
        loading: 'eager',
        style: { display: 'block', width: '100%', height: '100%', border: 0, background: '#04060d', colorScheme: 'dark' },
      }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'memory-nebula',
          order: 24,
          label: '记忆戴森球',
        }, NebulaIcon));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'memory-nebula',
        }, NebulaPage));
      },
    };
  },
});
