// create_artifact: a self-contained deliverable (page, diagram, document, code sample) that opens in the Browser pane.

import { formatBytes, kindLabel } from '../artifacts';
import type { Tool } from './types';

export const createArtifact: Tool = {
  name: 'create_artifact',
  description:
    'Create or update an artifact: a self-contained deliverable the user sees rendered in the Browser pane next to the chat. Kinds: "html" for a web page or small app (one file with inline CSS and JS; scripts and styles only from cdnjs.cloudflare.com, cdn.jsdelivr.net or unpkg.com, fonts from Google Fonts; no other network: fetch, beacons, outside images and forms are blocked), "svg" for a diagram or illustration, "markdown" for a document, report or write-up, "code" for a standalone code sample (set language). Use it for things meant to be viewed or handed over, not for project files (use write_file for those). To update an artifact, pass the id from an earlier result and the complete new content.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title shown on the artifact card' },
      kind: { type: 'string', enum: ['html', 'markdown', 'svg', 'code'], description: 'What the content is' },
      content: { type: 'string', description: 'The complete artifact: a full HTML document, SVG markup, Markdown, or source code' },
      language: { type: 'string', description: 'For kind "code": the language, e.g. python, typescript' },
      id: { type: 'string', description: 'The id of an existing artifact to update (from its earlier result). Omit to create a new one.' },
    },
    required: ['title', 'kind', 'content'],
  },
  async run(args, ctx) {
    const kind = String(args.kind ?? '').toLowerCase();
    if (!['html', 'markdown', 'svg', 'code'].includes(kind)) throw new Error('kind must be html, markdown, svg or code');
    const { info, action } = ctx.saveArtifact({
      id: args.id ? String(args.id).trim() : undefined,
      title: String(args.title ?? ''),
      kind: kind as 'html' | 'markdown' | 'svg' | 'code',
      language: args.language ? String(args.language) : undefined,
      content: String(args.content ?? ''),
    });
    return {
      content: `Artifact "${info.title}" ${action} (${kindLabel(info)}, v${info.version}, ${formatBytes(info.bytes)}) and shown in the Browser pane. id: ${info.id} — pass it to create_artifact to update it.`,
    };
  },
};
