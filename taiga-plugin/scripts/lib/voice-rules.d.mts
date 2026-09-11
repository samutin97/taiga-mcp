export interface VoiceRule { id: string; reason: string; pattern: string; flags?: string }
export interface VoiceRules { fields: string[]; hard: VoiceRule[]; soft: VoiceRule[] }
export interface CompiledRule { id: string; reason: string; level: "hard" | "soft"; re: RegExp }
export interface CompiledRules { fields: string[]; hard: CompiledRule[]; soft: CompiledRule[] }
export interface Finding { level: "hard" | "soft"; id: string; reason: string; quote: string; field: string }
export const RULES: VoiceRules;
export function compileRules(source?: VoiceRules): CompiledRules;
export function checkText(text: unknown, compiled?: CompiledRules): Finding[];
export function checkArgs(args: unknown, compiled?: CompiledRules): Finding[];
export function formatReason(findings: Finding[]): string;
