/**
 * Thetford Conservation Priorities - presentation view.
 *
 * Presents several tiered maps (ecological, agricultural), chosen with a switcher
 * at the top of the panel. Within a map it shows one thing at a time: that map's
 * combined tiered view, or a single contributing layer. Layers are coloured by the
 * tier they contribute to, so a layer and its tiered map always speak the same
 * visual language. Point values are deliberately not shown -- they determined the
 * tiers, but the tiers are the result worth presenting.
 *
 * Selection and description share one side panel: the description renders inline
 * beneath whichever row is selected, so the map keeps the rest of the screen.
 */
const App = {
    map: null,
    layer: null,          // the Leaflet layer currently on the map
    data: null,           // data/layers.json (generated -- rebuilt every time): { maps: [...] }
    content: null,        // data/content.json (hand-written prose -- never overwritten)
    layersById: {},       // every layer of every map, by rule id
    cache: {},            // geojson by key, fetched once
    selected: null,       // a map id (its tiered view) or a layer id
    mapId: null,          // the map whose layers the panel is listing
    collapsed: {},        // "<map>:<tier>" -> true when that group is folded shut
    townLayer: null,      // town outline, drawn on every view

    TIER_ORDER: ['red', 'yellow', 'green'],

    /**
     * Fetch a data file, revalidating rather than trusting the browser cache.
     * GitHub Pages lets browsers reuse files for ten minutes, so right after a
     * publish a viewer could get the new layers.json alongside stale geometry.
     * 'no-cache' still avoids re-downloading: an unchanged file comes back as a
     * 304 from its ETag.
     */
    async getJSON(path) {
        return (await fetch(path, { cache: 'no-cache' })).json();
    },

    async init() {
        this.map = L.map('map', { preferCanvas: true }).setView([43.835189, -72.252179], 12);
        L.esri.basemapLayer('Streets').addTo(this.map);

        // Its own pane above the data pane, so the outline stays visible whatever
        // gets added or removed underneath it.
        this.map.createPane('townPane').style.zIndex = 450;
        this.map.getPane('townPane').style.pointerEvents = 'none';
        await this.addTownBoundary();

        this.data = await this.getJSON('data/layers.json');

        // Prose is authored separately and overlaid here, so editing descriptions is
        // a text edit plus a refresh -- no rebuild, and a rebuild can't clobber it.
        try {
            this.content = await this.getJSON('data/content.json');
        } catch (e) {
            console.warn('content.json not found; using text from the builder', e);
            this.content = {};
        }
        for (const m of this.data.maps) {
            const c = this.content[`__map_${m.id}__`] || {};
            if (c.name) m.name = c.name;
            m.description = c.description || '';
            for (const l of m.layers) {
                l.mapId = m.id;
                const lc = this.content[l.id] || {};
                if (lc.name) l.name = lc.name;
                if (lc.goal !== undefined) l.goal = lc.goal;
                if (lc.motivation !== undefined) l.motivation = lc.motivation;
                this.layersById[l.id] = l;
            }
        }

        // Deep-link the current view, so a particular map or layer can be opened
        // directly from a bookmark or a link in slides.
        await this.select(this.keyFromHash());
        window.addEventListener('hashchange', () => this.select(this.keyFromHash()));
    },

    /** The view named in the URL; old #__tiered__ links meant the only map there was. */
    keyFromHash() {
        const h = decodeURIComponent(location.hash.slice(1));
        return (!h || h === '__tiered__') ? this.data.maps[0].id : h;
    },

    mapById(id) { return this.data.maps.find(m => m.id === id); },

    /** Town outline: always on, never selectable, never intercepts hover. */
    async addTownBoundary() {
        try {
            const geojson = await this.getJSON('data/town.geojson');
            this.townLayer = L.geoJSON(geojson, {
                pane: 'townPane',
                interactive: false,
                style: { color: '#3c4b57', weight: 2, opacity: 0.85, fill: false }
            }).addTo(this.map);
        } catch (e) {
            console.warn('town.geojson not found; continuing without the outline', e);
        }
    },

    /** Tiers this map actually defines, in display order. */
    tiersOf(m) { return this.TIER_ORDER.filter(t => m.tier_labels[t]); },

    renderLegend() {
        const m = this.mapById(this.mapId);
        document.getElementById('legend-title').textContent = m.legend_title || '';
        document.getElementById('legend-items').innerHTML = this.tiersOf(m).map(t => `
            <div class="key-row">
                <span class="swatch" style="background:${m.tier_colors[t]}"></span>
                <span>${m.tier_labels[t]}</span>
            </div>`).join('');
    },

    /** Rebuild the whole panel; the detail card is emitted inline after its row. */
    renderPanel() {
        const key = this.selected;
        const m = this.mapById(this.mapId);
        const out = [];

        out.push('<div class="switch" role="tablist">' + this.data.maps.map(x => `
            <button type="button" role="tab" data-map="${x.id}"
                    class="${x.id === m.id ? 'active' : ''}"
                    aria-selected="${x.id === m.id}">${x.short_name}</button>`).join('') + '</div>');

        const swatch = 'linear-gradient(135deg,' + this.tiersOf(m).map((t, i, a) =>
            `${m.tier_colors[t]} ${100 * i / a.length}% ${100 * (i + 1) / a.length}%`).join(',') + ')';
        out.push(`<div class="item combined ${key === m.id ? 'active' : ''}" data-key="${m.id}">
                      <span class="radio"></span><span class="swatch" style="background:${swatch}"></span>
                      <span class="label">${m.name}</span>
                  </div>`);
        if (key === m.id) out.push(this.detailHtml(m.id));

        out.push('<div class="caption">Contributing layers</div>');

        for (const tier of this.tiersOf(m)) {
            const layers = m.layers.filter(l => l.tier === tier);
            if (!layers.length) continue;

            const fold = `${m.id}:${tier}`;
            // Never leave the selected layer hidden inside a folded group.
            const collapsed = this.collapsed[fold] && !layers.some(l => l.id === key);

            out.push(`<div class="group ${collapsed ? 'collapsed' : ''}">
                <div class="group-head" data-toggle="${fold}">
                    <span class="chev"></span>
                    <span class="swatch" style="background:${m.tier_colors[tier]}"></span>
                    <span class="title">${m.tier_labels[tier]}</span>
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

        // Switching maps opens that map's tiered view.
        panel.querySelectorAll('.switch button').forEach(el =>
            el.addEventListener('click', () => this.select(el.dataset.map)));
        panel.querySelectorAll('.item').forEach(el =>
            el.addEventListener('click', () => this.select(el.dataset.key)));
        panel.querySelectorAll('.group-head').forEach(el =>
            el.addEventListener('click', () => {
                const f = el.dataset.toggle;
                this.collapsed[f] = !this.collapsed[f];
                this.renderPanel();
            }));
    },

    async load(key, file) {
        if (!this.cache[key]) this.cache[key] = await this.getJSON(file);
        return this.cache[key];
    },

    async select(key) {
        let m = this.mapById(key);
        if (!m) {
            const l = this.layersById[key];
            if (l) {
                m = this.mapById(l.mapId);
            } else {
                // Unknown or stale link: fall back to the first map.
                m = this.data.maps[0];
                key = m.id;
            }
        }
        if (this.selected === key) return;
        this.selected = key;
        if (location.hash.slice(1) !== key) location.hash = key;

        if (m.id !== this.mapId) {
            this.mapId = m.id;
            this.renderLegend();
        }
        this.renderPanel();

        const isMap = key === m.id;
        const geojson = await this.load(key, isMap ? `data/${m.tiered_file}` : `data/${key}.geojson`);
        if (this.selected !== key) return;   // a newer click won while we fetched

        if (this.layer) this.map.removeLayer(this.layer);
        this.hideHover();

        this.layer = isMap
            ? this.buildTieredLayer(geojson, m)
            : this.buildSingleLayer(geojson, this.layersById[key]);
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

    buildTieredLayer(geojson, m) {
        const self = this;
        const lowest = m.tier_colors[this.tiersOf(m).slice(-1)[0]];
        let hovered = null;
        const layer = L.geoJSON(geojson, {
            renderer: L.canvas(),
            style: f => self.styleFor(m.tier_colors[f.properties.tier] || lowest)
        });
        layer.on('mouseover', e => {
            if (!e.layer || !e.layer.feature) return;
            hovered = e.layer;
            e.layer.setStyle({ weight: 3, fillOpacity: 0.85 });
            self.showHover(e.layer.feature.properties, m);
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

    showHover(props, m) {
        const box = document.getElementById('hover-box');
        if (props.single) {
            const i = props.single;
            box.innerHTML = `<div class="name">${i.name}</div><div class="standing">${i.tier_label}</div>`;
        } else {
            let names = props.contributing_rules || [];
            if (typeof names === 'string') { try { names = JSON.parse(names); } catch (e) { names = []; } }
            const items = names.map(id => `<li>${(this.layersById[id] || {}).name || id}</li>`).join('');
            const label = m.tier_labels[props.tier] || '';
            box.innerHTML = `<div class="name">${label}</div>` +
                (items ? `<div class="standing">Contributing here</div><ul>${items}</ul>` : '');
        }
        box.style.display = 'block';
    },

    hideHover() { document.getElementById('hover-box').style.display = 'none'; },

    detailHtml(key) {
        const m = this.mapById(key);
        if (m) {
            const n = m.layers.length;
            return `<div class="note">
                <div class="standing">All tiers</div>
                ${m.description ? `<p>${m.description}</p>` : ''}
                <p class="term">Built from ${n} contributing ${n === 1 ? 'layer' : 'layers'} &mdash; select one to see it alone.</p>
            </div>`;
        }

        const l = this.layersById[key];
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
