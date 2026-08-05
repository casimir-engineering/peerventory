/**
 * Regenerates the README screenshots in docs/screenshots/.
 *
 * Seeds a fictional demo account (three inventories, generated photos, a
 * fake AI key, a second relay) into a throwaway browser profile through the
 * dev-only `window.__store` hook, then drives the app at a phone-sized
 * viewport and captures one PNG per screen.
 *
 * Nothing here is real: names, values, serials and the API key are invented,
 * and the QR codes point at localhost.
 *
 *   cd server && INVENTORY_DATA_DIR=/tmp/pv-relay-a PORT=8787 npx tsx src/index.ts
 *   cd server && INVENTORY_DATA_DIR=/tmp/pv-relay-b PORT=8788 npx tsx src/index.ts
 *   cd app && npx vite --port 5199              # dev build, exposes window.__store
 *   cd scripts/screenshots && npm install && npm run capture
 *
 * Then quantize the output: pngquant --force --ext .png --quality 60-88 docs/screenshots/*.png
 */

import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const APP = process.env.APP_ORIGIN ?? 'http://localhost:5199';
const OUT_DIR = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url));

/** Two relays, so multi-relay replication and the health dots have something to show. */
const RELAYS = ['http://localhost:8787', 'http://localhost:8788'];

const DAY = 86_400_000;
const now = Date.now();

const ALEX = 'ownr-alex-1';
const NORA = 'ownr-nora-1';

/** Item literal with the tedious defaults filled in. */
function item(id, description, extra = {}) {
  const { agedDays = 120, editedDays = 3, owner, place, ...rest } = extra;
  return {
    id,
    createdAt: now - agedDays * DAY,
    updatedAt: now - editedDays * DAY,
    description,
    quantity: 1,
    tags: [],
    photos: [],
    locationHistory: place ? [{ time: now - editedDays * DAY, label: place }] : [],
    ownerHistory: owner
      ? [{ time: now - agedDays * DAY, ownerId: owner.id, owner: owner.name }]
      : [],
    ...rest,
  };
}

const alex = { id: ALEX, name: 'Alex Reiter' };
const nora = { id: NORA, name: 'Nora Vogt' };

const LAB = {
  meta: {
    id: 'demo-lab-01',
    name: 'Electronics lab',
    description: 'Bench gear going to the Shenzhen office. Two cartons, air freight.',
    createdAt: now - 200 * DAY,
    ownerTrackingEnabled: true,
    currency: 'CHF',
    preciseLocation: false,
  },
  owners: {
    [ALEX]: { name: alex.name, updatedAt: now - 200 * DAY },
    [NORA]: { name: nora.name, updatedAt: now - 200 * DAY },
  },
  boxes: [
    { id: 'box-bench', label: 'Carton 1 · bench' },
    { id: 'box-parts', label: 'Carton 2 · parts' },
  ],
  savedLists: [],
  items: [
    item('itm-scope-01', 'Rigol DS1054Z oscilloscope', {
      category: 'Test gear',
      brandModel: 'Rigol DS1054Z',
      valueCurrent: { amount: 320, currency: 'CHF' },
      valueNew: { amount: 480, currency: 'CHF' },
      weight: { class: 'kg2_5', exactGrams: 3200 },
      dimensions: { class: 'carryon', exactMm: { l: 313, w: 161, h: 122 } },
      serialNumber: 'DS1ZA204812796',
      hsCode: '9030.20',
      condition: 'Used · good',
      acquisition: 'new',
      countryOfOrigin: 'CN',
      boxId: 'box-bench',
      purchase: { date: '2021-03-14', price: { amount: 599, currency: 'CHF' }, vendor: 'Distrelec' },
      translations: { zh: '数字示波器 四通道 50MHz' },
      notes: 'Probes and the power lead are taped to the lid.',
      owner: alex,
      place: 'Zürich · lab bench',
      photos: [
        { kind: 'instrument', hue: 205 },
        { kind: 'instrument', hue: 28, angle: 1 },
      ],
      agedDays: 4,
      editedDays: 1,
    }),
    item('itm-iron-002', 'Hakko FX-951 soldering station', {
      category: 'Test gear',
      brandModel: 'Hakko FX-951',
      valueCurrent: { amount: 210, currency: 'CHF' },
      valueNew: { amount: 310, currency: 'CHF' },
      weight: { class: 'kg1_2', exactGrams: 1650 },
      dimensions: { class: 'shoebox' },
      condition: 'Used · good',
      boxId: 'box-bench',
      countryOfOrigin: 'JP',
      owner: alex,
      place: 'Zürich · lab bench',
      photos: [{ kind: 'station', hue: 32 }],
      agedDays: 9,
      editedDays: 2,
    }),
    item('itm-fgen-003', 'Siglent SDG1032X function generator', {
      category: 'Test gear',
      brandModel: 'Siglent SDG1032X',
      valueCurrent: { amount: 290, currency: 'CHF' },
      weight: { class: 'kg2_5', exactGrams: 2400 },
      dimensions: { class: 'shoebox' },
      condition: 'Used · good',
      boxId: 'box-bench',
      owner: alex,
      place: 'Zürich · lab bench',
      photos: [{ kind: 'instrument', hue: 150 }],
      agedDays: 15,
      editedDays: 4,
    }),
    item('itm-logic-04', 'Saleae Logic 8 analyzer', {
      category: 'Test gear',
      valueCurrent: { amount: 180, currency: 'CHF' },
      weight: { class: 'g200_500', exactGrams: 240 },
      dimensions: { class: 'pocket' },
      condition: 'Used · good',
      boxId: 'box-parts',
      owner: nora,
      place: 'Zürich · lab bench',
      photos: [{ kind: 'puck', hue: 268 }],
      agedDays: 30,
      editedDays: 6,
    }),
    item('itm-psu-0005', 'Korad KA3005P bench supply', {
      category: 'Test gear',
      valueCurrent: { amount: 150, currency: 'CHF' },
      weight: { class: 'kg2_5', exactGrams: 3800 },
      dimensions: { class: 'shoebox' },
      condition: 'Used · fair',
      boxId: 'box-bench',
      owner: alex,
      place: 'Zürich · lab bench',
      photos: [{ kind: 'instrument', hue: 12 }],
      agedDays: 45,
      editedDays: 9,
    }),
    item('itm-solder-6', 'Solder spool 0.6 mm, Sn60Pb40', {
      category: 'Consumables',
      quantity: 3,
      valueCurrent: { amount: 42, currency: 'CHF' },
      weight: { class: 'g500_1k', exactGrams: 550 },
      dimensions: { class: 'pocket' },
      boxId: 'box-parts',
      owner: alex,
      photos: [{ kind: 'coil', hue: 48 }],
      agedDays: 75,
      editedDays: 11,
    }),
    item('itm-usbc-007', 'USB-C cable set, 1 m', {
      category: 'Cables',
      quantity: 12,
      valueCurrent: { amount: 8, currency: 'CHF' },
      weight: { class: 'lt50g', exactGrams: 45 },
      dimensions: { class: 'pocket' },
      boxId: 'box-parts',
      owner: alex,
      photos: [{ kind: 'coil', hue: 200 }],
      agedDays: 95,
      editedDays: 5,
    }),
    item('itm-iec-0008', 'Mains cable IEC C13, 2 m', {
      category: 'Cables',
      quantity: 6,
      valueCurrent: { amount: 4, currency: 'CHF' },
      weight: { class: 'g200_500', exactGrams: 210 },
      dimensions: { class: 'pocket' },
      boxId: 'box-parts',
      owner: alex,
      photos: [{ kind: 'coil', hue: 220 }],
      agedDays: 110,
      editedDays: 8,
    }),
    item('itm-cells-09', 'Li-ion 18650 cells, 4 pcs', {
      category: 'Consumables',
      quantity: 4,
      valueCurrent: { amount: 36, currency: 'CHF' },
      weight: { class: 'g200_500', exactGrams: 188 },
      dimensions: { class: 'pocket' },
      lithiumBattery: true,
      hsCode: '8507.60',
      boxId: 'box-parts',
      owner: alex,
      photos: [{ kind: 'cells', hue: 96 }],
      agedDays: 60,
      editedDays: 7,
    }),
    item('itm-pi5-0010', 'Raspberry Pi 5 kit, 8 GB', {
      category: 'Computers',
      valueCurrent: { amount: 120, currency: 'CHF' },
      valueNew: { amount: 145, currency: 'CHF' },
      weight: { class: 'g200_500', exactGrams: 320 },
      dimensions: { class: 'pocket' },
      condition: 'New',
      boxId: 'box-parts',
      countryOfOrigin: 'GB',
      owner: nora,
      photos: [{ kind: 'board', hue: 128 }],
      agedDays: 22,
      editedDays: 3,
    }),
    item('itm-esdmat-11', 'Anti-static mat and wrist strap', {
      category: 'Bench',
      valueCurrent: { amount: 55, currency: 'CHF' },
      weight: { class: 'kg1_2', exactGrams: 1400 },
      dimensions: { class: 'half_carton' },
      boxId: 'box-bench',
      owner: alex,
      photos: [{ kind: 'mat', hue: 190 }],
      agedDays: 140,
      editedDays: 14,
    }),
  ],
};

const APARTMENT = {
  meta: {
    id: 'demo-apt-01',
    name: 'Apartment',
    description: 'Household contents for the moving company estimate.',
    createdAt: now - 120 * DAY,
    ownerTrackingEnabled: true,
    currency: 'CHF',
    preciseLocation: false,
  },
  owners: {
    [ALEX]: { name: alex.name, updatedAt: now - 120 * DAY },
    [NORA]: { name: nora.name, updatedAt: now - 120 * DAY },
  },
  boxes: [
    { id: 'box-kitchen', label: 'Kitchen' },
    { id: 'box-living', label: 'Living room' },
  ],
  savedLists: [],
  items: [
    item('itm-espr-101', 'Sage Bambino espresso machine', {
      category: 'Kitchen',
      brandModel: 'Sage Bambino Plus',
      valueCurrent: { amount: 340, currency: 'CHF' },
      valueNew: { amount: 499, currency: 'CHF' },
      weight: { class: 'kg5_10', exactGrams: 5200 },
      dimensions: { class: 'half_carton' },
      condition: 'Used · good',
      boxId: 'box-kitchen',
      owner: nora,
      place: 'Zürich · flat',
      photos: [{ kind: 'appliance', hue: 210 }],
      agedDays: 5,
      editedDays: 2,
    }),
    item('itm-lamp-102', 'Floor lamp, brass', {
      category: 'Furniture',
      valueCurrent: { amount: 95, currency: 'CHF' },
      weight: { class: 'kg2_5', exactGrams: 4100 },
      dimensions: { class: 'oversize' },
      boxId: 'box-living',
      owner: alex,
      place: 'Zürich · flat',
      photos: [{ kind: 'lamp', hue: 40 }],
      agedDays: 12,
      editedDays: 12,
    }),
    item('itm-rug-0103', 'Wool rug, 160 × 230 cm', {
      category: 'Furniture',
      valueCurrent: { amount: 220, currency: 'CHF' },
      weight: { class: 'kg10_20', exactGrams: 12500 },
      dimensions: { class: 'oversize' },
      boxId: 'box-living',
      owner: nora,
      photos: [{ kind: 'rug', hue: 8 }],
      agedDays: 20,
      editedDays: 16,
    }),
    item('itm-books-104', 'Art books', {
      category: 'Books',
      quantity: 24,
      valueCurrent: { amount: 12, currency: 'CHF' },
      weight: { class: 'g500_1k', exactGrams: 780 },
      dimensions: { class: 'shoebox' },
      boxId: 'box-living',
      owner: alex,
      photos: [{ kind: 'books', hue: 320 }],
      agedDays: 45,
      editedDays: 20,
    }),
    item('itm-knives-105', 'Chef knife set, 5 pieces', {
      category: 'Kitchen',
      valueCurrent: { amount: 130, currency: 'CHF' },
      weight: { class: 'kg1_2', exactGrams: 1900 },
      dimensions: { class: 'shoebox' },
      boxId: 'box-kitchen',
      owner: nora,
      photos: [{ kind: 'knives', hue: 205 }],
      agedDays: 30,
      editedDays: 22,
    }),
    item('itm-jacket-106', 'Winter jacket, down', {
      category: 'Clothing',
      valueCurrent: { amount: 160, currency: 'CHF' },
      weight: { class: 'kg1_2', exactGrams: 1200 },
      dimensions: { class: 'half_carton' },
      condition: 'Used · good',
      owner: nora,
      photos: [{ kind: 'jacket', hue: 176 }],
      agedDays: 60,
      editedDays: 25,
    }),
  ],
};

const SHIPPING = {
  meta: {
    id: 'demo-ship-01',
    name: 'Shipping box #3',
    description: 'Sea freight, leaves Friday. Manifest goes to the forwarder.',
    createdAt: now - 40 * DAY,
    ownerTrackingEnabled: true,
    currency: 'CHF',
    preciseLocation: false,
  },
  owners: { [ALEX]: { name: alex.name, updatedAt: now - 40 * DAY } },
  boxes: [{ id: 'box-three', label: 'Carton 3' }],
  savedLists: [],
  items: [
    item('itm-drill-201', 'Bosch cordless drill, 18 V', {
      category: 'Tools',
      brandModel: 'Bosch GSR 18V-55',
      valueCurrent: { amount: 140, currency: 'CHF' },
      weight: { class: 'kg1_2', exactGrams: 1750 },
      dimensions: { class: 'shoebox' },
      lithiumBattery: true,
      hsCode: '8467.21',
      condition: 'Used · good',
      boxId: 'box-three',
      owner: alex,
      place: 'Basel · depot',
      photos: [{ kind: 'drill', hue: 132 }],
      agedDays: 3,
      editedDays: 4,
    }),
    item('itm-extcbl-202', 'Extension cable, 10 m', {
      category: 'Cables',
      valueCurrent: { amount: 25, currency: 'CHF' },
      weight: { class: 'g500_1k', exactGrams: 900 },
      dimensions: { class: 'pocket' },
      boxId: 'box-three',
      owner: alex,
      photos: [{ kind: 'coil', hue: 268 }],
      agedDays: 24,
      editedDays: 10,
    }),
    item('itm-stove-203', 'Camping stove and gas adapter', {
      category: 'Outdoor',
      valueCurrent: { amount: 60, currency: 'CHF' },
      weight: { class: 'g500_1k', exactGrams: 820 },
      dimensions: { class: 'shoebox' },
      boxId: 'box-three',
      owner: alex,
      photos: [{ kind: 'stove', hue: 22 }],
      agedDays: 16,
      editedDays: 13,
    }),
    item('itm-teaset-204', 'Porcelain tea set', {
      category: 'Kitchen',
      valueCurrent: { amount: 480, currency: 'CNY' },
      weight: { class: 'kg2_5', exactGrams: 2100 },
      dimensions: { class: 'half_carton' },
      condition: 'New',
      countryOfOrigin: 'CN',
      boxId: 'box-three',
      owner: alex,
      translations: { zh: '青花瓷茶具一套' },
      photos: [{ kind: 'teaset', hue: 198 }],
      agedDays: 8,
      editedDays: 6,
    }),
  ],
};

/**
 * Browser-side seeding: draws the demo photos on a canvas and pushes each
 * inventory through the store's own import path.
 */
async function seedInPage(payload) {
  const store = window.__store;

  const roundRect = (ctx, x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  };

  const shadow = (ctx, cx, cy, rx, ry) => {
    const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, rx);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    ctx.translate(-cx, -cy);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  /** One fictional "product photo": studio backdrop plus a drawn object. */
  async function makePhoto(spec) {
    // Square, because every thumbnail in the app is a square crop.
    const W = 1200;
    const H = 1200;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const hue = spec.hue ?? 205;

    const back = ctx.createLinearGradient(0, 0, 0, H);
    back.addColorStop(0, `hsl(${hue} 14% 30%)`);
    back.addColorStop(0.58, `hsl(${hue} 12% 21%)`);
    back.addColorStop(0.6, `hsl(${hue} 10% 17%)`);
    back.addColorStop(1, `hsl(${hue} 9% 11%)`);
    ctx.fillStyle = back;
    ctx.fillRect(0, 0, W, H);

    const key = ctx.createRadialGradient(W * 0.42, H * 0.1, 20, W * 0.42, H * 0.18, W * 0.85);
    key.addColorStop(0, 'rgba(255,255,255,0.18)');
    key.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = key;
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2;
    const base = H * 0.72;
    const body = `hsl(${hue} 32% 58%)`;
    const bodyDark = `hsl(${hue} 30% 38%)`;
    const bodyLight = `hsl(${hue} 40% 72%)`;
    const metal = 'hsl(220 8% 78%)';

    ctx.save();
    // The drawings are laid out for a ~700px subject; fill more of the frame.
    ctx.translate(cx, base);
    ctx.scale(1.35, 1.35);
    if (spec.angle) ctx.rotate((spec.angle * Math.PI) / 180);
    ctx.translate(-cx, -base);

    const kind = spec.kind ?? 'instrument';
    shadow(ctx, cx, base + 24, 430, 70);

    if (kind === 'instrument') {
      const w = 720;
      const h = 420;
      ctx.fillStyle = bodyDark;
      roundRect(ctx, cx - w / 2, base - h, w, h, 26);
      ctx.fillStyle = body;
      roundRect(ctx, cx - w / 2, base - h, w, h - 26, 26);
      ctx.fillStyle = 'hsl(150 45% 8%)';
      roundRect(ctx, cx - w / 2 + 40, base - h + 44, w * 0.58, h - 130, 12);
      ctx.strokeStyle = 'hsla(150 60% 60% / 0.22)';
      ctx.lineWidth = 2;
      for (let gx = 1; gx < 8; gx++) {
        const x = cx - w / 2 + 40 + (w * 0.58 * gx) / 8;
        ctx.beginPath();
        ctx.moveTo(x, base - h + 48);
        ctx.lineTo(x, base - h + h - 90);
        ctx.stroke();
      }
      ctx.strokeStyle = 'hsl(150 80% 62%)';
      ctx.lineWidth = 5;
      ctx.beginPath();
      for (let x = 0; x <= w * 0.58; x += 4) {
        const y = Math.sin((x / 60) * Math.PI) * 60;
        const px = cx - w / 2 + 40 + x;
        const py = base - h + (h - 90) / 2 + y;
        if (x === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      for (let k = 0; k < 3; k++) {
        const kx = cx + w * 0.22;
        const ky = base - h + 90 + k * 110;
        ctx.fillStyle = 'hsl(220 8% 20%)';
        ctx.beginPath();
        ctx.arc(kx, ky, 44, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = metal;
        ctx.beginPath();
        ctx.arc(kx, ky, 34, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'hsl(220 10% 35%)';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(kx, ky);
        ctx.lineTo(kx + 22 * Math.cos(k), ky + 22 * Math.sin(k));
        ctx.stroke();
      }
    } else if (kind === 'station') {
      ctx.fillStyle = bodyDark;
      roundRect(ctx, cx - 330, base - 300, 480, 300, 24);
      ctx.fillStyle = body;
      roundRect(ctx, cx - 330, base - 300, 480, 260, 24);
      ctx.fillStyle = 'hsl(0 0% 8%)';
      roundRect(ctx, cx - 290, base - 250, 240, 120, 10);
      ctx.fillStyle = 'hsl(12 90% 60%)';
      ctx.font = 'bold 84px ui-monospace, monospace';
      ctx.fillText('340', cx - 275, base - 158);
      ctx.fillStyle = metal;
      ctx.save();
      ctx.translate(cx + 250, base - 120);
      ctx.rotate(-0.5);
      roundRect(ctx, -30, -200, 60, 320, 26);
      ctx.fillStyle = 'hsl(0 0% 20%)';
      roundRect(ctx, -18, -260, 36, 80, 14);
      ctx.restore();
    } else if (kind === 'puck') {
      ctx.fillStyle = bodyDark;
      roundRect(ctx, cx - 260, base - 170, 520, 170, 30);
      ctx.fillStyle = body;
      roundRect(ctx, cx - 260, base - 180, 520, 150, 30);
      ctx.fillStyle = 'hsla(0 0% 100% / 0.14)';
      roundRect(ctx, cx - 220, base - 160, 440, 44, 18);
      for (let k = 0; k < 8; k++) {
        ctx.fillStyle = 'hsl(220 10% 22%)';
        roundRect(ctx, cx - 200 + k * 52, base - 60, 30, 22, 6);
      }
    } else if (kind === 'coil') {
      ctx.lineCap = 'round';
      for (let k = 0; k < 5; k++) {
        ctx.strokeStyle = k % 2 ? bodyDark : body;
        ctx.lineWidth = 40;
        ctx.beginPath();
        ctx.ellipse(cx, base - 170, 250 - k * 10, 150 - k * 12, k * 0.16, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.strokeStyle = bodyLight;
      ctx.lineWidth = 34;
      ctx.beginPath();
      ctx.moveTo(cx + 180, base - 260);
      ctx.bezierCurveTo(cx + 340, base - 300, cx + 380, base - 120, cx + 260, base - 40);
      ctx.stroke();
    } else if (kind === 'cells') {
      for (let k = 0; k < 4; k++) {
        const x = cx - 280 + k * 150;
        ctx.fillStyle = k % 2 ? body : bodyDark;
        roundRect(ctx, x, base - 340, 110, 340, 16);
        ctx.fillStyle = metal;
        roundRect(ctx, x + 34, base - 366, 42, 30, 8);
        ctx.fillStyle = 'hsla(0 0% 100% / 0.16)';
        roundRect(ctx, x + 14, base - 320, 22, 300, 10);
      }
    } else if (kind === 'board') {
      ctx.fillStyle = `hsl(${hue} 45% 26%)`;
      roundRect(ctx, cx - 360, base - 250, 720, 250, 18);
      ctx.fillStyle = 'hsl(48 60% 62%)';
      for (let k = 0; k < 20; k++) roundRect(ctx, cx - 330 + k * 34, base - 236, 18, 34, 4);
      ctx.fillStyle = 'hsl(220 8% 16%)';
      roundRect(ctx, cx - 120, base - 170, 170, 120, 12);
      ctx.fillStyle = metal;
      roundRect(ctx, cx + 120, base - 160, 200, 90, 10);
      roundRect(ctx, cx - 330, base - 140, 130, 80, 10);
    } else if (kind === 'mat') {
      ctx.fillStyle = bodyDark;
      ctx.beginPath();
      ctx.moveTo(cx - 460, base);
      ctx.lineTo(cx - 300, base - 210);
      ctx.lineTo(cx + 460, base - 210);
      ctx.lineTo(cx + 300, base);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.moveTo(cx - 440, base - 14);
      ctx.lineTo(cx - 288, base - 216);
      ctx.lineTo(cx + 440, base - 216);
      ctx.lineTo(cx + 288, base - 14);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'hsla(0 0% 100% / 0.2)';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(cx + 250, base - 150, 44, 0, Math.PI * 2);
      ctx.stroke();
    } else if (kind === 'appliance') {
      ctx.fillStyle = metal;
      roundRect(ctx, cx - 240, base - 520, 480, 520, 34);
      ctx.fillStyle = 'hsl(220 6% 62%)';
      roundRect(ctx, cx - 240, base - 200, 480, 200, 34);
      ctx.fillStyle = 'hsl(220 8% 26%)';
      roundRect(ctx, cx - 150, base - 300, 300, 60, 16);
      ctx.beginPath();
      ctx.arc(cx, base - 250, 42, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `hsl(${hue} 40% 60%)`;
      ctx.beginPath();
      ctx.arc(cx - 140, base - 430, 34, 0, Math.PI * 2);
      ctx.arc(cx + 140, base - 430, 34, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'hsl(0 0% 92%)';
      roundRect(ctx, cx - 70, base - 130, 140, 120, 14);
    } else if (kind === 'lamp') {
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.moveTo(cx - 180, base - 560);
      ctx.lineTo(cx + 180, base - 560);
      ctx.lineTo(cx + 120, base - 380);
      ctx.lineTo(cx - 120, base - 380);
      ctx.closePath();
      ctx.fill();
      const glow = ctx.createRadialGradient(cx, base - 400, 10, cx, base - 400, 340);
      glow.addColorStop(0, 'hsla(45 90% 75% / 0.5)');
      glow.addColorStop(1, 'hsla(45 90% 75% / 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(cx - 400, base - 700, 800, 700);
      ctx.fillStyle = bodyLight;
      roundRect(ctx, cx - 14, base - 400, 28, 380, 10);
      ctx.fillStyle = bodyDark;
      ctx.beginPath();
      ctx.ellipse(cx, base - 10, 150, 34, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'rug') {
      ctx.save();
      ctx.translate(cx, base - 150);
      ctx.rotate(-0.12);
      for (let k = 6; k >= 0; k--) {
        ctx.fillStyle = k % 2 ? body : bodyDark;
        roundRect(ctx, -420, -110 + k * 6, 840, 220 - k * 8, 110);
      }
      ctx.fillStyle = bodyLight;
      ctx.beginPath();
      ctx.ellipse(-400, 0, 40, 105, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (kind === 'books') {
      const colors = [body, bodyDark, bodyLight, `hsl(${(hue + 40) % 360} 35% 52%)`];
      let y = base;
      for (let k = 0; k < 4; k++) {
        const w = 620 - k * 40;
        const h = 62 + (k % 2) * 14;
        y -= h + 6;
        ctx.fillStyle = colors[k % colors.length];
        roundRect(ctx, cx - w / 2 + (k % 2 ? 18 : -12), y, w, h, 8);
        ctx.fillStyle = 'hsla(0 0% 100% / 0.18)';
        roundRect(ctx, cx - w / 2 + (k % 2 ? 18 : -12) + 12, y + 10, w - 24, 6, 3);
      }
    } else if (kind === 'knives') {
      for (let k = 0; k < 5; k++) {
        ctx.save();
        ctx.translate(cx - 300 + k * 150, base - 40);
        ctx.rotate(-0.18);
        ctx.fillStyle = metal;
        ctx.beginPath();
        ctx.moveTo(-26, -160);
        ctx.lineTo(26, -190 - k * 18);
        ctx.lineTo(20, -40);
        ctx.lineTo(-20, -40);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'hsl(24 30% 22%)';
        roundRect(ctx, -22, -46, 44, 120, 12);
        ctx.restore();
      }
    } else if (kind === 'jacket') {
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.moveTo(cx - 240, base - 420);
      ctx.quadraticCurveTo(cx, base - 500, cx + 240, base - 420);
      ctx.lineTo(cx + 200, base - 20);
      ctx.lineTo(cx - 200, base - 20);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = bodyDark;
      ctx.lineWidth = 14;
      for (let k = 1; k < 6; k++) {
        ctx.beginPath();
        ctx.moveTo(cx - 226 + k * 6, base - 400 + k * 66);
        ctx.lineTo(cx + 226 - k * 6, base - 400 + k * 66);
        ctx.stroke();
      }
      ctx.fillStyle = bodyLight;
      roundRect(ctx, cx - 16, base - 440, 32, 420, 12);
    } else if (kind === 'drill') {
      ctx.fillStyle = body;
      roundRect(ctx, cx - 260, base - 380, 380, 190, 60);
      roundRect(ctx, cx - 150, base - 230, 170, 230, 40);
      ctx.fillStyle = bodyDark;
      roundRect(ctx, cx - 200, base - 70, 280, 70, 22);
      ctx.fillStyle = metal;
      roundRect(ctx, cx + 110, base - 340, 190, 110, 30);
      roundRect(ctx, cx + 280, base - 305, 130, 40, 18);
    } else if (kind === 'stove') {
      ctx.fillStyle = metal;
      ctx.beginPath();
      ctx.ellipse(cx, base - 120, 260, 90, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'hsl(220 8% 40%)';
      ctx.beginPath();
      ctx.ellipse(cx, base - 150, 200, 70, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `hsl(${hue} 70% 55%)`;
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.ellipse(cx + Math.cos(a) * 110, base - 150 + Math.sin(a) * 38, 34, 18, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = bodyDark;
      roundRect(ctx, cx - 40, base - 300, 80, 160, 20);
    } else if (kind === 'teaset') {
      ctx.fillStyle = 'hsl(210 20% 94%)';
      ctx.beginPath();
      ctx.ellipse(cx - 40, base - 190, 190, 150, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'hsl(210 20% 94%)';
      ctx.lineWidth = 34;
      ctx.beginPath();
      ctx.arc(cx + 170, base - 200, 70, -1.2, 1.2);
      ctx.stroke();
      ctx.fillStyle = `hsl(${hue} 60% 42%)`;
      for (let k = 0; k < 5; k++) {
        ctx.beginPath();
        ctx.ellipse(cx - 150 + k * 55, base - 210, 16, 34, 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = 'hsl(210 20% 88%)';
      ctx.beginPath();
      ctx.ellipse(cx - 290, base - 60, 95, 60, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = body;
      roundRect(ctx, cx - 300, base - 300, 600, 300, 20);
    }
    ctx.restore();

    // A little grain, so the render does not read as flat vector art.
    for (let k = 0; k < 5000; k++) {
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.035})`;
      ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2);
    }
    const vignette = ctx.createRadialGradient(cx, H * 0.45, H * 0.25, cx, H * 0.45, H * 0.95);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, W, H);

    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  }

  const created = [];
  for (const inventory of payload.inventories) {
    const blobs = new Map();
    const items = [];
    for (const raw of inventory.items) {
      const photos = [];
      for (let i = 0; i < raw.photos.length; i++) {
        const hash = `${raw.id}-p${i}`;
        blobs.set(hash, await makePhoto(raw.photos[i]));
        photos.push({
          hash,
          mime: 'image/jpeg',
          role: raw.photos[i].role ?? 'photo',
          addedAt: raw.updatedAt,
        });
      }
      items.push({ ...raw, photos });
    }
    const docId = await store.importSnapshot(
      {
        meta: inventory.meta,
        items,
        boxes: inventory.boxes,
        savedLists: inventory.savedLists ?? [],
        owners: inventory.owners,
      },
      blobs,
    );
    created.push({ name: inventory.meta.name, docId, itemIds: items.map((i) => i.id) });
  }
  return created;
}

/* ------------------------------------------------------------------ */

await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  reducedMotion: 'reduce',
  locale: 'en-GB',
  timezoneId: 'Europe/Zurich',
});

await context.addInitScript(
  ([relays, fakeKey]) => {
    localStorage.setItem(
      'profile:v1',
      JSON.stringify({ userName: 'Alex Reiter', ownerId: 'ownr-alex-1', lastCurrency: 'CHF' }),
    );
    localStorage.setItem('profile-name-welcome-dismissed:v1', '1');
    // Invented key, short on purpose: it only has to render as a masked value.
    localStorage.setItem('aiKey:v1', fakeKey);
    localStorage.setItem(
      'relays:v1',
      JSON.stringify(relays.map((url) => ({ url, enabled: true }))),
    );
    // Fixed conversion table: screenshots must not depend on a live FX fetch.
    localStorage.setItem(
      'fx:v1',
      JSON.stringify({
        fetchedAt: Date.now(),
        rates: { USD: 1, CHF: 0.88, EUR: 0.92, GBP: 0.78, CNY: 7.1, JPY: 152 },
      }),
    );
  },
  [RELAYS, 'sk-ant-api03-demo-not-a-real-key'],
);

const page = await context.newPage();
page.on('pageerror', (err) => console.warn('[page error]', err.message));

const shot = async (name) => {
  await page.waitForFunction(() =>
    [...document.images].every((img) => img.complete && img.naturalWidth > 0),
  );
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT_DIR}${name}.png` });
  console.log(`  wrote ${name}.png`);
};

const go = async (hash) => {
  await page.goto(`${APP}/${hash}`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
};

try {
  await page.goto(APP);
  await page.waitForFunction(() => window.__store?.importSnapshot, undefined, { timeout: 60_000 });

  console.log('seeding demo inventories…');
  const created = await page.evaluate(seedInPage, {
    inventories: [LAB, APARTMENT, SHIPPING],
  });
  for (const inv of created) console.log(`  ${inv.name} -> ${inv.docId} (${inv.itemIds.length} items)`);

  const lab = created.find((c) => c.name === 'Electronics lab');

  // Let the docs reach the relay so the sync dots and "synced" lines are real.
  await page.waitForTimeout(6_000);

  console.log('capturing…');

  await go('#/');
  await page.waitForSelector('.list-rows .list-row');
  await shot('01-home');

  await page.fill('input[type=search]', 'cable');
  await page.waitForSelector('.list-rows .list-row .thumb');
  await page.waitForTimeout(600);
  await shot('02-search');

  await go(`#/inv/${lab.docId}`);
  await page.waitForSelector('.item-grid .item-card');
  await shot('03-items');

  await go(`#/inv/${lab.docId}/i/itm-scope-01`);
  await page.waitForSelector('.gallery img');
  await shot('04-item');

  await page.getByRole('button', { name: 'Move to another inventory…' }).click();
  await page.waitForSelector('.modal, [role=dialog]');
  await page.getByRole('button', { name: /Apartment/ }).click();
  await shot('05-move');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Share', exact: true }).first().click();
  await page.waitForSelector('canvas');
  await page.waitForTimeout(800);
  await shot('06-share');
  await page.keyboard.press('Escape');

  await go(`#/inv/${lab.docId}/stats`);
  await page.waitForSelector('.stat-card');
  await shot('07-stats');

  await go(`#/inv/${lab.docId}/settings`);
  await page.waitForSelector('.card');
  await page.evaluate(() => {
    const heading = [...document.querySelectorAll('h2, .section-title, .card')].find((el) =>
      el.textContent?.trim().startsWith('Export'),
    );
    heading?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(400);
  await shot('08-settings');

  await go('#/account');
  await page.waitForSelector('.card');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1500); // relay health probes
  await shot('09-account');

  await page.evaluate(() => window.scrollTo(0, 520));
  await page.waitForTimeout(400);
  await shot('10-relays');
} finally {
  await browser.close();
}

console.log('done');
