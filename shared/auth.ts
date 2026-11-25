export type SrpChallenge = { id: string; p: string; g: number; salt1: string; salt2: string; b: string };
export type QrState =
  | { stage: 'qr'; image: string; expires: number }
  | { stage: 'srp'; challenge: SrpChallenge }
  | { stage: 'connected' };
import type { SessionState } from './protocol';


export type QrResponse = Exclude<QrState, { stage: 'connected' }> | { stage: 'connected'; session: SessionState };
