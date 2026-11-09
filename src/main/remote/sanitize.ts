// What of a session the remote page gets to see. Images stay on the Mac (a phone on a shared network should not pull
// screenshots and pasted pictures), long tool results are cut, and stored-file paths are left out.

import type { AgentEvent, ArtifactInfo, LiveState, MessageOrigin, TranscriptItem } from '../../shared/types';
import type { ImageInfo } from '../../shared/images';
import type { AutoBlock } from '../../shared/auto-mode';

export const MAX_RESULT = 20_000;

/** A transcript item as the remote page receives it: a user item has an image count instead of data URLs. */
export type RemoteItem =
  | { role: 'user'; text: string; images?: number; turn?: number; origin?: MessageOrigin; from?: string }
  | Exclude<TranscriptItem, { role: 'user' } | { role: 'artifact' } | { role: 'image' } | { role: 'auto_blocked' }>
  /** `allowable`: the block is one of this app session's, so Allow works (api.ts sets it) */
  | { role: 'auto_blocked'; block: AutoBlock; allowable?: boolean }
  | { role: 'artifact'; artifact: RemoteArtifact }
  | { role: 'image'; image: RemoteImage };

type RemoteArtifact = Pick<ArtifactInfo, 'id' | 'title' | 'kind' | 'version'>;
type RemoteImage = Pick<ImageInfo, 'id' | 'name' | 'caption' | 'width' | 'height'>;

export function cut(s: string, max = MAX_RESULT): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters on the Mac)` : s;
}

const artifact = (a: ArtifactInfo): RemoteArtifact => ({ id: a.id, title: a.title, kind: a.kind, version: a.version });
const image = (i: ImageInfo): RemoteImage => ({ id: i.id, name: i.name, caption: i.caption, width: i.width, height: i.height });

export function remoteItem(item: TranscriptItem): RemoteItem {
  switch (item.role) {
    case 'user': {
      const out: Extract<RemoteItem, { role: 'user' }> = { role: 'user', text: item.text };
      if (item.images?.length) out.images = item.images.length;
      if (item.turn !== undefined) out.turn = item.turn;
      // Where it came from when it was not typed (another session, a schedule, …), so the page can label it
      if (item.origin && item.origin !== 'user' && item.origin !== 'queue') out.origin = item.origin;
      if (item.from) out.from = item.from;
      return out;
    }
    case 'tool':
      return { ...item, result: cut(item.result) };
    // The page has no proposal cards: a dream's proposal reads as the tool call it was
    case 'proposal':
      return { role: 'tool', name: item.name, args: item.args, result: cut(item.result), ok: true };
    case 'artifact':
      return { role: 'artifact', artifact: artifact(item.artifact) };
    case 'image':
      return { role: 'image', image: image(item.image) };
    default:
      return item;
  }
}

export type RemoteLive = Omit<LiveState, 'queue'> & { queue: { id: string; text: string; images: number; createdAt: number }[] };

export function remoteLive(live: LiveState): RemoteLive {
  return {
    ...live,
    queue: live.queue.map((q) => ({ id: q.id, text: q.text, images: q.attachments?.length ?? 0, createdAt: q.createdAt })),
  };
}

/** An agent event for the stream, or null when it carries nothing the page uses. */
export function remoteEvent(ev: AgentEvent): unknown | null {
  switch (ev.type) {
    case 'tool_end': {
      const { image: _image, ...rest } = ev;
      return { ...rest, result: cut(ev.result) };
    }
    case 'image':
      return { type: 'image', image: image(ev.image) };
    case 'artifact':
      return { type: 'artifact', action: ev.action, artifact: artifact(ev.artifact) };
    // Token counts and the context meter are desktop chrome; the remote has no use for them.
    case 'usage':
    case 'context':
      return null;
    default:
      return ev;
  }
}
