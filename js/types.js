/** @typedef {"disease"|"drug"|"concept"} Kind */
/** @typedef {"assoc"|"treats"|"causes"|"mech"|"contra"} LinkType */

/** @typedef {{ streak:number, lastRating:string|null, last:number, due:number, retired:boolean }} SectionSR */
/** @typedef {{ version:number, sections:Record<string, SectionSR> }} SR */

/** @typedef {{ blockId:string, id:number, name:string, week:number }} LectureRef */

/// Base item
/**
 * @typedef {Object} Base
 * @property {string} id
 * @property {Kind} kind
 * @property {boolean} favorite
 * @property {string|null} color         // pastel override or null
 * @property {{ id:string, title:string, body:string }[]} extras
 * @property {string[]} facts            // legacy chips
 * @property {string[]} tags             // chips
 * @property {{id:string, type:LinkType}[]} links
 * @property {string[]} blocks           // ["F1","MSK"]
 * @property {number[]} weeks            // [1,3]
 * @property {LectureRef[]} lectures     // chosen by number → resolves name+week
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {SR} sr
 */

/** @typedef {Base & {
 *  kind:"disease", name:string, etiology:string, pathophys:string,
 *  clinical:string, diagnosis:string, treatment:string, complications:string, mnemonic:string
 * }} Disease */

/** @typedef {Base & {
 *  kind:"drug", name:string, class:string, source:string, moa:string, uses:string,
 *  sideEffects:string, contraindications:string, mnemonic:string
 * }} Drug */

/** @typedef {Base & {
 *  kind:"concept", concept:string, type:string, definition:string,
 *  mechanism:string, clinicalRelevance:string, example:string, mnemonic:string
 * }} Concept */

/** @typedef {Disease|Drug|Concept} Item */

/** @typedef {{ blockId:string, title:string, weeks:number,
 *              color?:string, order:number,
 *              lectures:{id:number, name:string, week:number}[],
 *              createdAt:number, updatedAt:number }} BlockDef */

/** @typedef {{ id:string, stem:string, options:{id:string,text:string}[], answer:string, explanation?:string, tags?:string[], media?:string }} Question */

/** @typedef {{ id:string, examTitle:string, block?:string, week?:string,
 *   timerMode:"timed"|"untimed", secondsPerQuestion:number,
 *   questions:Question[], results:ExamResult[] }} Exam */

/** @typedef {{ id:string, when:number, correct:number, total:number, answers:Record<number,string>, flagged:number[], durationMs:number, answered:number }} ExamResult */

/** @typedef {{ dailyCount:number, theme:"dark" }} Settings */

/** @typedef {{ items:Item[], blocks:BlockDef[], exams:Exam[], settings:Settings }} DB */
