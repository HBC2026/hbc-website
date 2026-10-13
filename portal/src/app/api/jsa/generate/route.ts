import { AiError, CONTROLS_SCHEMA, REFINE_SCHEMA, STRUCTURE_SCHEMA, aiConfig, callJson } from '@/lib/jsa/ai';
import { controlsPrompt, refinePrompt, structurePrompt, SYSTEM_PROMPT, type JobContext, type Reference } from '@/lib/jsa/prompt';
import { rankReferences, selectRules, type KbCandidate } from '@/lib/jsa/retrieve';
import { authorize, json } from '@/lib/jsa/server';
import { cleanControl, coverageGaps, validateControls } from '@/lib/jsa/validate';

export const runtime = 'nodejs';
export const maxDuration = 60;

const str = (v: unknown, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
const strs = (v: unknown, n: number, max = 1200) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, n).map((x: string) => x.slice(0, max)) : []);

function jobOf(v: unknown): JobContext {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { project: str(o.project, 500), client: str(o.client, 500), location: str(o.location, 500), work_description: str(o.work_description, 4000), equipment: str(o.equipment, 2000), additional_instructions: str(o.additional_instructions, 4000) };
}

export async function GET(req: Request) {
  const a = await authorize(req);
  if (a instanceof Response) return a;
  const cfg = aiConfig();
  return json({ configured: !!cfg, provider: cfg?.provider ?? null, model: cfg?.model ?? null });
}

export async function POST(req: Request) {
  const a = await authorize(req);
  if (a instanceof Response) return a;
  const cfg = aiConfig();
  if (!cfg) return json({ error: 'AI generation is not configured. Set JSA_AI_API_KEY (and optionally JSA_AI_PROVIDER / JSA_AI_MODEL) in the server environment, then redeploy.', code: 'no_key' }, 503);

  const raw = await req.text();
  if (raw.length > 120_000) return json({ error: 'The request is too large.' }, 413);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return json({ error: 'Invalid request.' }, 400); }

  try {
    const task = str(body.task, 20);

    /* ------------------------------------------------ control measures for one hazard */
    if (task === 'controls') {
      const count = Math.min(25, Math.max(3, Math.round(Number(body.count) || 20)));
      const existing = strs(body.existing, 80);
      const q = { activity: str(body.activity, 1000), category: str(body.category, 200), hazard: str(body.hazardName, 600), equipment: `${str(body.equipment, 2000)} ${str(body.activityEquipment, 1000)}` };

      // Retrieval from the approved knowledge base and rules (read through the caller's own RLS-scoped session)
      const [kb, rules, settings] = await Promise.all([
        a.sb.from('safety_knowledge_base').select('id, work_activity, hazard, equipment, controls, applicable_rules, tags').eq('status', 'approved').limit(1000),
        a.sb.from('safety_rules').select('kind, title, body, equipment, active').eq('active', true).limit(300),
        a.sb.from('jsa_settings').select('key, value').in('key', ['company_instructions', 'ai_preferences']),
      ]);
      const refs = rankReferences((kb.data ?? []) as KbCandidate[], q) as (KbCandidate & { id: string })[];
      const ruleList = selectRules((rules.data ?? []) as { kind: string; title: string; body: string; equipment: string; active: boolean }[], `${q.activity} ${q.equipment} ${q.hazard}`);
      const st: Record<string, string> = {};
      (settings.data ?? []).forEach((r: { key: string; value: unknown }) => { st[r.key] = typeof r.value === 'string' ? r.value : ''; });

      const prompt = controlsPrompt({
        activity: q.activity, activityEquipment: str(body.activityEquipment, 1000), activityInstructions: str(body.activityInstructions, 2000),
        category: q.category, hazardName: q.hazard, hazardInstructions: str(body.hazardInstructions, 2000),
        count, job: jobOf(body.job), instructions: str(body.instructions, 4000),
        companyInstructions: st.company_instructions ?? '', aiPreferences: st.ai_preferences ?? '',
        references: refs as Reference[], rules: ruleList, existing, needMore: existing.length > 0,
      });
      const out = await callJson(cfg, {
        system: SYSTEM_PROMPT, user: prompt, name: 'submit_controls', description: 'Submit the control measures and any flags.',
        schema: CONTROLS_SCHEMA, maxTokens: 7000,
      }, (r) => { if (!Array.isArray((r as { controls?: unknown }).controls)) throw new AiError('The AI response was missing the controls list.', 502, true); });

      const o = out as { controls: unknown[]; flags?: unknown[] };
      const v = validateControls(o.controls, existing);
      const flags = (Array.isArray(o.flags) ? o.flags : []).map(cleanControl).filter(Boolean).slice(0, 8);
      return json({
        controls: v.controls.slice(0, 40), flags, droppedCount: v.dropped.length,
        gaps: coverageGaps(q.category, [...existing, ...v.controls]),
        references: refs.map((r) => ({ id: r.id, work_activity: r.work_activity, hazard: r.hazard })),
        ruleCount: ruleList.length,
      });
    }

    /* ------------------------------------------------ shorten / expand one control */
    if (task === 'refine') {
      const action = body.action === 'shorten' ? 'shorten' : 'expand';
      const text = str(body.text, 1500);
      if (!text.trim()) return json({ error: 'Nothing to rewrite.' }, 400);
      const out = await callJson(cfg, {
        system: SYSTEM_PROMPT, user: refinePrompt({ text, action, activity: str(body.activity, 1000), hazardName: str(body.hazardName, 600), job: jobOf(body.job), instruction: str(body.instructions, 1000) }),
        name: 'submit_text', description: 'Submit the rewritten control measure.', schema: REFINE_SCHEMA, maxTokens: 800,
      }, (r) => { if (typeof (r as { text?: unknown }).text !== 'string') throw new AiError('Unreadable AI response.', 502, true); });
      const t = cleanControl((out as { text: string }).text);
      if (!t) return json({ error: 'The AI returned an empty rewrite.' }, 502);
      return json({ text: t });
    }

    /* ------------------------------------------------ turn messy text into activities / hazards / controls */
    if (task === 'structure') {
      const text = str(body.text, 40000);
      if (text.trim().length < 20) return json({ error: 'There is not enough text to analyse.' }, 400);
      const out = await callJson(cfg, {
        system: SYSTEM_PROMPT, user: structurePrompt(text, strs(body.categories, 40, 100)),
        name: 'submit_structure', description: 'Submit the structured activities.', schema: STRUCTURE_SCHEMA, maxTokens: 12000,
      }, (r) => { if (!Array.isArray((r as { activities?: unknown }).activities)) throw new AiError('Unreadable AI response.', 502, true); });
      const acts = ((out as { activities: unknown[] }).activities).slice(0, 60).map((x) => {
        const a2 = (x ?? {}) as { title?: unknown; equipment?: unknown; hazards?: unknown[] };
        return {
          title: str(a2.title, 500), equipment: str(a2.equipment, 500),
          hazards: (Array.isArray(a2.hazards) ? a2.hazards : []).slice(0, 30).map((h) => {
            const hz = (h ?? {}) as { name?: unknown; controls?: unknown[] };
            return { name: str(hz.name, 300), controls: validateControls(hz.controls ?? []).controls.slice(0, 60) };
          }),
        };
      }).filter((x) => x.title);
      return json({ activities: acts });
    }

    return json({ error: 'Unknown request.' }, 400);
  } catch (e) {
    if (e instanceof AiError) return json({ error: e.message }, e.status === 499 ? 499 : e.status >= 500 ? 502 : e.status);
    return json({ error: 'Something went wrong while contacting the AI service.' }, 500);
  }
}
