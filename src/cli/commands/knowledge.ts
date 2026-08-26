/**
 * `lanes link knowledge` — which store holds this profile's memory and skills.
 *
 * A barrel, matching `owner.ts` and `operate.ts` beside it, so `main.ts` binds
 * one path per noun rather than one per file. The command itself is three files
 * under `knowledge/`: the token and the repository probe, the migration, and
 * the grammar that puts them in order.
 */

export { knowledgeShow, knowledgeUse, type KnowledgeFlags } from './knowledge/index.ts';
