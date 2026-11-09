import type { Tool } from './types';

export const skillTool: Tool = {
  name: 'skill',
  description:
    'Load a skill by name and follow its instructions. Skills are reusable procedures listed in the system prompt. Call this before starting a task that matches a skill.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Skill name exactly as listed' } },
    required: ['name'],
  },
  async run(args, ctx) {
    const name = String(args.name ?? '').toLowerCase().replace(/^\//, '');
    const skill = ctx.skills.find((s) => s.name === name);
    if (!skill) {
      const available = ctx.skills.map((s) => s.name).join(', ') || '(none)';
      throw new Error(`Unknown skill "${name}". Available skills: ${available}`);
    }
    return { content: `<skill name="${skill.name}">\n${skill.body}\n</skill>\n\nFollow these instructions for the user's request now.` };
  },
};
