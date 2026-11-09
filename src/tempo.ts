// Utilitários de data/hora no fuso da escola (independente do fuso do servidor)
import { config } from './config.js';

export interface Agora {
  data: string;       // YYYY-MM-DD
  hora: string;       // HH:MM
  diaSemana: number;  // 0 = domingo
  completo: string;   // YYYY-MM-DD HH:MM:SS
}

const DIAS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function agoraNaEscola(d: Date = new Date(), fuso = config.fusoHorario): Agora {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23',
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  const data = `${partes.year}-${partes.month}-${partes.day}`;
  const hora = `${partes.hour}:${partes.minute}`;
  return { data, hora, diaSemana: DIAS[partes.weekday], completo: `${data} ${hora}:${partes.second}` };
}

/** Converte 'dd/mm/aaaa hh:mm:ss' (formato Henry) para 'aaaa-mm-dd hh:mm:ss'. */
export function deHenry(s: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{2,4}) (\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const ano = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${ano}-${m[2]}-${m[1]} ${m[4]}:${m[5]}:${m[6]}`;
}

/** Converte 'aaaa-mm-dd hh:mm:ss' para 'dd/mm/aaaa hh:mm:ss' (formato Henry). */
export function paraHenry(s: string): string {
  const [d, h] = s.split(' ');
  const [a, m, dia] = d.split('-');
  return `${dia}/${m}/${a} ${h}`;
}
