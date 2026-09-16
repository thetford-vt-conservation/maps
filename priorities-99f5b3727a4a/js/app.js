/**
 * Thetford Conservation Priorities - presentation view.
 *
 * Shows one thing at a time: the combined tiered map, or a single contributing
 * layer. Layers are coloured by the tier they contribute to, so a layer and the
 * finished map always speak the same visual language. Point values are
 * deliberately not shown -- they determined the tiers, but the tiers are the
 * result worth presenting.
 *
 * Selection and description share one side panel: the description renders inline
 * beneath whichever row is selected, so the map keeps the rest of the screen.
 */
const App = {
    map: null,
    layer: null,          // the Leaflet layer currently on the map
    meta: null,           // data/layers.json  (generated -- rebuilt every time)
    content: null,        // data/content.json (hand-written prose -- never overwritten)
    cache: {},            // geojson by key, fetched once
    selected: null,
    collapsed: {},        // tier -> true when that group is folded shut
    townLayer: null,      // town outline, drawn on every view

    TIER_ORDER: ['red', 'yellow', 'green'],

    async init() {
        this.map = L.map('map', { preferCanvas: true }).setView([43.835189, -72.252179], 12);
        L.esri.basemapLayer('Streets').addTo(this.map);

        // Its own pane above the data pane, so the outline stays visible whatever
        // gets added or removed underneath it.
        this.map.createPane('townPane').style.zIndex = 450;
        this.map.getPane('townPane').style.pointerEvents = 'none';
        await this.addTownBoundary();

        this.meta = await (await fetch('data/layers.json')).json();

        // Prose is authored separately and overlaid here, so editing descriptions is
        // a text edit plus a refresh -- no rebuild, and a rebuild can't clobber it.
        try {
            this.content = await (await fetch('data/content.json')).json();
        } catch (e) {
            console.warn('content.json not found; using text from the builder', e);
            this.content = {};
        }
        for (const l of this.meta.layers) {
            const c = this.content[l.id] || {};
            if (c.name) l.name = c.name;
            if (c.goal !== undefined) l.goal = c.goal;
            if (c.motivation !== undefined) l.motivation = c.motivation;
        }

        this.renderLegend();

        // Deep-link the current view, so a particular layer can be opened directly
        // from a bookmark or a link in slides.
        await this.select(location.hash.slice(1) || '__tiered__');
        window.addEventListener('hashchange',
            () => this.select(location.hash.slice(1) || '__tiered__'));
    },

    /** Town outline: always on, never selectable, never intercepts hover. */
    async addTownBoundary() {
        try {
            const geojson = await (await fetch('data/town.geojson')).json();
            this.townLayer = L.geoJSON(geojson, {
                pane: 'townPane',
                interactive: false,
                style: { color: '#3c4b57', weight: 2, opacity: 0.85, fill: false }
            }).addTo(this.map);
        } catch (e) {
            console.warn('town.geojson not found; continuing without the outline', e);
        }
    },

    renderLegend() {
        document.getElementById('legend-items').innerHTML = this.TIER_ORDER.map(t => `
            <div class="key-row">
                <span class="swatch" style="background:${this.meta.tier_colors[t]}"></span>
                <span>${this.meta.tier_labels[t]}</span>
            </div>`).join('');
    },

    /** Rebuild the whole panel; the detail card is emitted inline after its row. */
    renderPanel() {
        const key = this.selected;
        const out = [];

        const tieredName = ((this.content && this.content.__tiered__) || {}).name || 'Tiered Map';
        out.push(`<div class="item combined ${key === '__tiered__' ? 'active' : ''}" data-key="__tiered__">
                      <span class="radio"></span><span class="swatch"></span>
                      <span class="label">${tieredName}</span>
                  </div>`);
        if (key === '__tiered__') out.push(this.detailHtml('__tiered__'));

        out.push('<div class="caption">Contributing layers</div>');

        for (const tier of this.TIER_ORDER) {
            const layers = this.meta.layers.filter(l => l.tier === tier);
            if (!layers.length) continue;

            const holdsSelection = layers.some(l => l.id === key);
            // Never leave the selected layer hidden inside a folded group.
            const collapsed = this.collapsed[tier] && !holdsSelection;

            out.push(`<div class="group ${collapsed ? 'collapsed' : ''}" data-tier="${tier}">
                <div class="group-head" data-toggle="${tier}">
                    <span class="chev"></span>
                    <span class="swatch" style="background:${this.meta.tier_colors[tier]}"></span>
                    <span class="title">${this.meta.tier_labels[tier]}</span>
                    <span class="count">${layers.length}</span>
                </div>
                <div class="group-body">`);

            for (const l of layers) {
                out.push(`<div class="item ${l.id === key ? 'active' : ''}" data-key="${l.id}">
                              <span class="radio"></span>
                              <span class="swatch" style="background:${l.color}"></span>
                              <span class="label">${l.name}</span>
                          </div>`);
                if (l.id === key) out.push(this.detailHtml(l.id));
            }
            out.push('</div></div>');
        }

        const panel = document.getElementById('panel');
        panel.innerHTML = out.join('');

        panel.querySelectorAll('.item').forEach(el =>
            el.addEventListener('click', () => this.select(el.dataset.key)));
        panel.querySelectorAll('.group-head').forEach(el =>
            el.addEventListener('click', () => {
                const t = el.dataset.toggle;
                this.collapsed[t] = !this.collapsed[t];
                this.renderPanel();
            }));
    },

    async load(key) {
        if (!this.cache[key]) {
            const file = key === '__tiered__' ? 'data/tiered.geojson' : `data/${key}.geojson`;
            this.cache[key] = await (await fetch(file)).json();
        }
        return this.cache[key];
    },

    async select(key) {
        if (key !== '__tiered__' && !this.meta.layers.some(l => l.id === key)) key = '__tiered__';
        if (this.selected === key) return;
        this.selected = key;
        if (location.hash.slice(1) !== key) location.hash = key;

        this.renderPanel();

        const geojson = await this.load(key);
        if (this.selected !== key) return;   // a newer click won while we fetched

        if (this.layer) this.map.removeLayer(this.layer);
        this.hideHover();

        this.layer = (key === '__tiered__')
            ? this.buildTieredLayer(geojson)
            : this.buildSingleLayer(geojson, this.meta.layers.find(l => l.id === key));
        this.layer.addTo(this.map);
    },

    /** Darker shade of the fill, so borders don't read as a black mesh. */
    darken(hex, factor = 0.6) {
        const n = parseInt(hex.slice(1), 16);
        const r = Math.round(((n >> 16) & 255) * factor);
        const g = Math.round(((n >> 8) & 255) * factor);
        const b = Math.round((n & 255) * factor);
        return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
    },

    styleFor(color) {
        return { fillColor: color, color: this.darken(color), weight: 1, opacity: 0.7, fillOpacity: 0.7 };
    },

    buildTieredLayer(geojson) {
        const self = this;
        let hovered = null;
        const layer = L.geoJSON(geojson, {
            renderer: L.canvas(),
            style: f => self.styleFor(self.meta.tier_colors[f.properties.tier] || self.meta.tier_colors.green)
        });
        layer.on('mouseover', e => {
            if (!e.layer || !e.layer.feature) return;
            hovered = e.layer;
            e.layer.setStyle({ weight: 3, fillOpacity: 0.85 });
            self.showHover(e.layer.feature.properties);
        });
        layer.on('mouseout', () => {
            if (hovered) { layer.resetStyle(hovered); hovered = null; }
            self.hideHover();
        });
        return layer;
    },

    buildSingleLayer(geojson, info) {
        const self = this;
        const layer = L.geoJSON(geojson, {
            renderer: L.canvas(),
            style: () => self.styleFor(info.color)
        });
        layer.on('mouseover', () => self.showHover({ single: info }));
        layer.on('mouseout', () => self.hideHover());
        return layer;
    },

    showHover(props) {
        const box = document.getElementById('hover-box');
        if (props.single) {
            const i = props.single;
            box.innerHTML = `<div class="name">${i.name}</div><div class="standing">${i.tier_label}</div>`;
        } else {
            const tier = props.tier || 'green';
            let names = props.contributing_rules || [];
            if (typeof names === 'string') { try { names = JSON.parse(names); } catch (e) { names = []; } }
            const byId = Object.fromEntries(this.meta.layers.map(l => [l.id, l.name]));
            const items = names.map(id => `<li>${byId[id] || id}</li>`).join('');
            box.innerHTML = `<div class="name">${this.meta.tier_labels[tier]}</div>` +
                (items ? `<div class="standing">Contributing here</div><ul>${items}</ul>` : '');
        }
        box.style.display = 'block';
    },

    hideHover() { document.getElementById('hover-box').style.display = 'none'; },

    detailHtml(key) {
        if (key === '__tiered__') {
            const t = (this.content && this.content.__tiered__) || {};
            const n = this.meta.layers.length;
            return `<div class="note">
                <div class="standing">All tiers</div>
                <p>${t.description || ''}</p>
                <p class="term">Built from ${n} contributing layers &mdash; select one to see it alone.</p>
            </div>`;
        }

        const l = this.meta.layers.find(x => x.id === key);
        const b = [`<div class="note tier-${l.tier}">`];
        b.push(`<div class="standing">${l.tier_label}</div>`);

        // Extent as a sentence: this is a conservation document, not a dashboard.
        b.push(`<p>${l.acres.toLocaleString()} acres in town, across
                ${l.features.toLocaleString()} separate ${l.features === 1 ? 'area' : 'areas'}.</p>`);

        if (l.goal) b.push(`<p class="hdr">Goal</p><p>${l.goal}</p>`);
        if (l.motivation) b.push(`<p class="hdr">Why it matters</p><p>${l.motivation}</p>`);
        if (l.how_built) b.push(`<p class="hdr">How it was defined</p><p class="built">${l.how_built}</p>`);
        if (l.sources && l.sources.length) {
            const s = l.sources.map(x => x.url
                ? `<a href="${x.url}" target="_blank" rel="noopener">${x.name}</a>` : x.name).join(', ');
            b.push(`<p class="term">Source: ${s}</p>`);
        }
        b.push('</div>');
        return b.join('');
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());
