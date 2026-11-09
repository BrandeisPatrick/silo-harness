import { clipboard, ClipboardItem, dialog, nativeImage, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ImageInfo } from '../shared/images';
import type { App } from './app';
import { clearLocalImages, localImagePath } from './images/local';
import { MAX_IMAGE_BYTES, servableImage } from './images/sniff';
import { copyImages, dropImages, imagesByCall, listImages, resolveUserPath } from './images/store';
import type { ImagesService } from './services';
import { showImageTool } from './tools/image';

// Feature: Images. The show_image tool, the stored copies and their artifact:// URLs, the window's images.* RPC,
// and the 'images' service (the Outputs panel lists a session's images through it).
export function setupImages(app: App): void {
  const root = path.join(app.userData, 'artifacts');
  const session = (id?: string) => app.store.get(id ? String(id) : app.runtime.foregroundId());
  const image = (id: string, sessionId?: string): ImageInfo => {
    const img = session(sessionId)?.images?.[String(id)];
    if (!img) throw new Error(`No image ${id} in this conversation.`);
    return img;
  };

  app.tools.register(showImageTool(app));
  app.prompt.add(
    'images',
    () => 'To show the user an image inline in your reply, call show_image with its path.',
  );

  const service: ImagesService = {
    list: (sessionId) => listImages(app.store.get(sessionId)),
    get: (sessionId, id) => app.store.get(sessionId)?.images?.[id],
  };
  app.provide('images', service);

  app.store.onMutation((s, op) => {
    if (op.kind === 'fork') {
      // The store's fork copies messages, not files: the fork gets its own copies before its first save.
      const from = app.store.get(op.from);
      if (from?.images) copyImages(root, from, s);
    } else if (op.kind === 'truncate' && s.images) {
      // A rewind drops the calls after the checkpoint; the images they showed go with them.
      const all = [...(s.compactions ?? []).flatMap((c) => c.folded), ...s.messages, ...op.removed];
      const removedCalls = new Set(op.removed.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []).map((c) => c.id) : [])));
      const gone = [...imagesByCall(s, all)].filter(([call]) => removedCalls.has(call)).map(([, img]) => img.id);
      if (gone.length) dropImages(s, gone);
    }
  });

  app.rpc.handle('images.list', (sessionId) => listImages(session(sessionId)));

  app.rpc.handle('images.resolve', (ref, sessionId) => {
    const raw = String(ref ?? '').trim();
    if (!raw) return { error: 'no path' };
    // The window never loads images from the network: a remote image is a tracking and exfiltration channel.
    if (/^(?:[a-z]+:)?\/\//i.test(raw) && !/^file:\/\//i.test(raw)) return { error: 'remote images are not loaded' };
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^file:/i.test(raw)) return { error: 'only local image files can be shown' };
    const s = session(sessionId);
    const file = resolveUserPath(raw, s?.cwd ?? app.config().workingDirectory);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return { error: 'not a file' };
      if (st.size > MAX_IMAGE_BYTES) return { error: 'too large' };
    } catch {
      return { error: 'not found' };
    }
    const kind = servableImage(file);
    if (!kind) return { error: 'not an image' };
    return { url: `artifact://view/${localImagePath(file, kind)}`, name: path.basename(file) };
  });

  app.rpc.handle('images.reveal', (id, sessionId) => {
    shell.showItemInFolder(image(id, sessionId).path);
  });

  app.rpc.handle('images.saveAs', async (id, sessionId) => {
    const img = image(id, sessionId);
    const ext = path.extname(img.path);
    // The stored copy's extension is the real type; a misnamed source gets it added
    const name = path.extname(img.name).toLowerCase() === ext || (ext === '.jpg' && /\.jpe?g$/i.test(img.name)) ? img.name : `${img.name}${ext}`;
    const win = app.window();
    const opts = { defaultPath: name, filters: [{ name: 'Image', extensions: [ext.slice(1)] }] };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    fs.copyFileSync(img.path, r.filePath);
    return r.filePath;
  });

  app.rpc.handle('images.copy', async (id, sessionId) => {
    const img = nativeImage.createFromPath(image(id, sessionId).path);
    // SVG (and formats the system cannot decode) come back empty; the window then copies it through a canvas.
    if (img.isEmpty()) return false;
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' }) })]);
    return true;
  });

  app.onQuit(() => clearLocalImages());
}
