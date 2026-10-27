#!/usr/bin/env node
// Flyen DICOM Viewer — MCP server for Claude (stdio, no dependencies).
//
// The same file is the Claude Desktop extension (flyen-dicom-viewer.mcpb, run
// with Claude Desktop's built-in Node.js) and the server of the Flyen plugin
// (public repo flyen-claude-plugin, run with the computer's node in Cowork and
// Claude Code) — copy it there after a change. Each tool call is
// forwarded to the running Flyen program over 127.0.0.1, using the port and
// token Flyen writes to %LOCALAPPDATA%\DICOMViewer\mcp_bridge.json while
// "AI → Allow Claude Desktop to control Flyen" is on (see ai_bridge.py).
// Flyen never returns the patient's name, ID, birth date, institution or file
// paths; age and sex are given. Text burned into the image pixels can still be
// visible.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const readline = require('readline');

const SERVER_INFO = { name: 'flyen-dicom-viewer', version: '1.3.0' };
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const STATE_FILE = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'DICOMViewer', 'mcp_bridge.json');

const NOT_DIAG = ' Results are for viewing support only — not for diagnosis.';

const TOOLS = [
  {
    name: 'segmentation_sets',
    description: 'What AI segmentation can find on the current series: the main '
      + 'set (117 structures on CT, 50 on MR) and the detailed sets (lungs: '
      + 'arteries, veins, airways, nodules, effusion; liver segments, vessels, '
      + 'lesions; kidney cysts; brain haemorrhage; teeth; head and neck) — each '
      + 'with its structure names, how many are found already, whether it is '
      + 'experimental, the model download still needed (MB) and the expected '
      + 'minutes on this computer. Call before segmentation_run.' + NOT_DIAG,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_state',
    description: 'What Flyen shows now: view mode (2d / mpr / 3d), the series of '
      + 'the study (index, description, modality, slice count), the current '
      + 'series, slice and window, available presets, and the AI segmentation '
      + 'state (structures found with volumes, which are shown). Call this first. '
      + 'Contains no patient identity.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_view_image',
    description: 'Picture of the current view (2D slice, the three MPR planes, '
      + 'or the 3D rendering) including coloured AI-segmentation overlays — '
      + 'image pixels only, without Flyen\'s on-screen text or the patient data '
      + 'stored in the DICOM file. Text burned into the image itself (ultrasound, '
      + 'scanned documents, screenshots) can still be visible — do not repeat '
      + 'names or other identifiers you may read there.\n'
      + 'POINTS: every tool that takes a point uses x, y as FRACTIONS of one '
      + 'plane image (0,0 = top-left, 1,1 = bottom-right) — in MPR pick that '
      + 'plane with `plane`. To locate points precisely: `grid`: true draws '
      + 'labelled coordinate lines; `region` {x,y,w,h} returns that part at full '
      + 'detail (zoom for small findings; the grid still shows whole-image '
      + 'fractions); `marks` [[x,y],…] draws numbered crosses so you can check '
      + 'points before measuring. `plane` / `region` / `grid` / `marks` work in '
      + '2D and MPR.' + NOT_DIAG,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        plane: { type: 'string', enum: ['axial', 'coronal', 'sagittal'] },
        region: {
          type: 'object', additionalProperties: false,
          properties: { x: { type: 'number' }, y: { type: 'number' },
            w: { type: 'number' }, h: { type: 'number' } },
        },
        grid: { type: 'boolean' },
        marks: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
      },
    },
  },
  {
    name: 'select_series',
    description: 'Show another series of the study in the active panel (returns '
      + 'to 2D). Use the index from get_state.',
    inputSchema: {
      type: 'object', required: ['index'], additionalProperties: false,
      properties: { index: { type: 'integer', minimum: 0 } },
    },
  },
  {
    name: 'set_slice',
    description: 'Go to a slice: absolute `index` (0-based) or relative `step` '
      + '(e.g. 10 / -10). In 2D the active panel; in MPR the position of '
      + '`plane` (axial by default, or coronal / sagittal).',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        index: { type: 'integer' }, step: { type: 'integer' },
        plane: { type: 'string', enum: ['axial', 'coronal', 'sagittal'] },
      },
    },
  },
  {
    name: 'set_window',
    description: 'Set the window (contrast): a named `preset` (see get_state → '
      + 'window_presets, e.g. Lung, Bone, Soft Tissue, Brain, Abdomen, Liver) or '
      + '`center` and `width` in HU.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        preset: { type: 'string' }, center: { type: 'number' }, width: { type: 'number' },
      },
    },
  },
  {
    name: 'set_view_mode',
    description: "Switch the view: '2d', 'mpr' (axial / coronal / sagittal) or "
      + "'3d' (volume rendering; opening 3D can take a few seconds).",
    inputSchema: {
      type: 'object', required: ['mode'], additionalProperties: false,
      properties: { mode: { type: 'string', enum: ['2d', 'mpr', '3d'] } },
    },
  },
  {
    name: 'set_3d_preset',
    description: 'In 3D, pick a rendering preset (see get_state → presets_3d, '
      + 'e.g. Soft Tissue, Bones, Angio, Dental).',
    inputSchema: {
      type: 'object', required: ['name'], additionalProperties: false,
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'measure_hu',
    description: 'Density in a circle around a point of the current slice / MPR '
      + 'plane: mean, SD, min, max and the value at the centre — HU for CT. '
      + '`radius_mm` default 3; keep the circle inside the structure (check with '
      + 'get_view_image marks first). Single slice even when a thick slab is on.'
      + NOT_DIAG,
    inputSchema: {
      type: 'object', required: ['x', 'y'], additionalProperties: false,
      properties: { x: { type: 'number' }, y: { type: 'number' },
        radius_mm: { type: 'number' }, plane: { type: 'string', enum: ['axial', 'coronal', 'sagittal'] } },
    },
  },
  {
    name: 'measure_distance',
    description: 'Distance in mm between two points of the current slice / MPR '
      + 'plane (true pixel spacing). `show`: true also draws the line for the '
      + 'user (2D).' + NOT_DIAG,
    inputSchema: {
      type: 'object', required: ['x1', 'y1', 'x2', 'y2'], additionalProperties: false,
      properties: { x1: { type: 'number' }, y1: { type: 'number' },
        x2: { type: 'number' }, y2: { type: 'number' }, plane: { type: 'string', enum: ['axial', 'coronal', 'sagittal'] }, show: { type: 'boolean' } },
    },
  },
  {
    name: 'annotate',
    description: 'Show the user where to look: an arrow with a short label on '
      + 'the current 2D slice, tip at (x, y); optional tail position. It stays '
      + 'with Flyen\'s measurements until clear_annotations.',
    inputSchema: {
      type: 'object', required: ['x', 'y', 'text'], additionalProperties: false,
      properties: { x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' },
        tail_x: { type: 'number' }, tail_y: { type: 'number' } },
    },
  },
  {
    name: 'clear_annotations',
    description: 'Remove the arrows and lines you drew (the user\'s own stay).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'set_mpr_point',
    description: 'In MPR, move the crosshair to a point of one plane — the other '
      + 'two planes then pass through it (e.g. click a nodule in axial to see it '
      + 'in coronal and sagittal).',
    inputSchema: {
      type: 'object', required: ['plane', 'x', 'y'], additionalProperties: false,
      properties: { plane: { type: 'string', enum: ['axial', 'coronal', 'sagittal'] }, x: { type: 'number' }, y: { type: 'number' } },
    },
  },
  {
    name: 'set_slab',
    description: 'Thick-slab projection in 2D and MPR: `mode` max (MIP — vessels, '
      + 'nodules), min (MinIP — airways, emphysema) or mean, `mm` thick; mm 0 or '
      + 'mode off = single slice.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { mm: { type: 'number' },
        mode: { type: 'string', enum: ['max', 'min', 'mean', 'off'] } },
    },
  },
  {
    name: 'set_zoom',
    description: 'Zoom the USER\'s view (1 = fit, up to 20) centred on (x, y) — '
      + 'to point them at a finding. For your own close look use get_view_image '
      + 'region instead.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { zoom: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, plane: { type: 'string', enum: ['axial', 'coronal', 'sagittal'] } },
    },
  },
  {
    name: 'compare_series',
    description: 'Show 2–4 series of the study side by side in 2D (e.g. before '
      + 'and after contrast). `indices` from get_state.',
    inputSchema: {
      type: 'object', required: ['indices'], additionalProperties: false,
      properties: { indices: { type: 'array', items: { type: 'integer' } } },
    },
  },
  {
    name: 'get_series_info',
    description: 'Technical data of a series (default: the current one): body '
      + 'part, slice thickness, pixel spacing, kVp, kernel, contrast agent, MR '
      + 'sequence / TR / TE, scanner, study date, and the patient\'s age and sex. '
      + 'Never the name, ID, birth date or institution.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { index: { type: 'integer', minimum: 0 } },
    },
  },
  {
    name: 'segmentation_stats',
    description: 'Volume (ml) and density (mean / SD; HU on CT, the scanner\'s '
      + 'signal values on MR) of AI-segmented structures of the current series — '
      + '`structures` names, or all found.'
      + NOT_DIAG,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { structures: { type: 'array', items: { type: 'string' } } },
    },
  },
  {
    name: 'list_studies',
    description: 'Studies opened recently on this computer: index, when opened, '
      + 'modality, number of series (no names or paths).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'open_study',
    description: 'Open a study from list_studies by `index`. Loads in the '
      + 'background — call get_state after a few seconds.',
    inputSchema: {
      type: 'object', required: ['index'], additionalProperties: false,
      properties: { index: { type: 'integer', minimum: 0 } },
    },
  },
  {
    name: 'segmentation_show',
    description: 'Control the AI segmentation layer (2D, MPR and 3D together): '
      + '`show` / `hide` lists of structure names (e.g. "pancreas", "liver", '
      + '"vertebrae_L1", "liver_segment_4", "lung_arteries"; "lung" matches all '
      + 'lobes; names from get_state / segmentation_sets), `only`: true = show just '
      + 'the listed ones with everything else hidden, `all`: true = show every '
      + 'found structure, `layer`: false/true = hide / show the whole layer. '
      + 'Needs the AI segmentation add-on on in the tab.' + NOT_DIAG,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        show: { type: 'array', items: { type: 'string' } },
        hide: { type: 'array', items: { type: 'string' } },
        only: { type: 'boolean' },
        all: { type: 'boolean' },
        layer: { type: 'boolean' },
      },
    },
  },
  {
    name: 'segmentation_run',
    description: 'Start AI segmentation (TotalSegmentator, on this computer) of '
      + 'the current CT or MR series for the listed `structures` — names from '
      + 'segmentation_sets (empty = the whole main set: 117 on CT, 50 on MR). A '
      + 'structure of a detailed set (lung vessels, liver segments, teeth…) runs '
      + 'its whole set; structures of several sets run one after another. Runs '
      + 'in the background for minutes (a detailed set up to ~45 min on the '
      + 'CPU; the first use of a set downloads its model); poll get_state → '
      + 'ai_segmentation.running. `fast`: quicker, coarser main model.' + NOT_DIAG,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        structures: { type: 'array', items: { type: 'string' } },
        fast: { type: 'boolean' },
      },
    },
  },
];

// Title and behaviour hints of every tool (shown by Claude, used for its
// permission prompts): read-only tools only look; the others change what
// Flyen shows on screen, never the study files. Nothing leaves this computer
// except through Claude itself (openWorldHint false).
const HINTS = {
  segmentation_sets: ['List segmentation sets', true],
  get_state: ['Get viewer state', true],
  get_view_image: ['Get view image', true],
  select_series: ['Select series', false],
  set_slice: ['Go to slice', false],
  set_window: ['Set window', false],
  set_view_mode: ['Set view mode', false],
  set_3d_preset: ['Set 3D preset', false],
  measure_hu: ['Measure density', true],
  measure_distance: ['Measure distance', false],
  annotate: ['Draw arrow', false],
  clear_annotations: ['Clear arrows', false],
  set_mpr_point: ['Move MPR crosshair', false],
  set_slab: ['Set slab projection', false],
  set_zoom: ['Zoom view', false],
  compare_series: ['Compare series', false],
  get_series_info: ['Get series info', true],
  segmentation_stats: ['Segmentation statistics', true],
  list_studies: ['List recent studies', true],
  open_study: ['Open study', false],
  segmentation_show: ['Show segmentation', false],
  segmentation_run: ['Run AI segmentation', false],
};
for (const t of TOOLS) {
  const [title, readOnly] = HINTS[t.name];
  t.title = title;
  t.annotations = { title, readOnlyHint: readOnly, destructiveHint: false,
    idempotentHint: readOnly, openWorldHint: false };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function callFlyen(tool, args) {
  const st = readState();
  if (!st) {
    return Promise.reject(new Error(
      'Flyen is not running, or Claude access is off. In Flyen open the AI '
      + 'menu and choose "Allow Claude Desktop to control Flyen".'));
  }
  const body = JSON.stringify({ tool, args: args || {} });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: st.port, path: '/call', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Flyen-Token': st.token,
      },
      timeout: 200000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) reject(new Error(j.error));
          else resolve(j.result);
        } catch (e) {
          reject(new Error('bad answer from Flyen'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Flyen did not answer in time')));
    req.on('error', () => reject(new Error(
      'Cannot reach Flyen. Is the program open with "Allow Claude Desktop to '
      + 'control Flyen" switched on?')));
    req.end(body);
  });
}

async function callTool(name, args) {
  if (!TOOLS.some((t) => t.name === name)) {
    return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
  }
  try {
    const res = await callFlyen(name, args);
    if (res && res.png_base64) {
      return {
        content: [
          { type: 'image', data: res.png_base64, mimeType: 'image/png' },
          { type: 'text', text: res.caption },
        ],
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(res, null, 1) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: String(e.message || e) }], isError: true };
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === 'initialize') {
      const asked = params && params.protocolVersion;
      return send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: 'Flyen is a DICOM viewer open on this computer. Start with '
            + 'get_state, look with get_view_image, then change the view with the '
            + 'other tools. Points are fractions (0…1) of one plane image — use '
            + 'get_view_image grid / region / marks to place them, then '
            + 'measure_hu / measure_distance for real numbers instead of guessing, '
            + 'and annotate to show the user. Describe what you see carefully and '
            + 'remind the user that this is not a diagnosis.',
        },
      });
    }
    if (method === 'tools/list') {
      return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    }
    if (method === 'tools/call') {
      const r = await callTool(params.name, params.arguments || {});
      return send({ jsonrpc: '2.0', id, result: r });
    }
    if (method === 'ping') {
      return send({ jsonrpc: '2.0', id, result: {} });
    }
    if (isRequest) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
    // notifications (e.g. notifications/initialized) need no answer
  } catch (e) {
    if (isRequest) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
    }
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  handle(msg);
});
rl.on('close', () => process.exit(0));
