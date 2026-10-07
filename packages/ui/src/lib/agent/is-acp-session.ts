import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { isAcpSessionRecord } from './types';

// Absence is unknown, never evidence that the selected backend owns a session.
export const isAcpSession = (sessionId: string): boolean =>
  isAcpSessionRecord(useGlobalSessionsStore.getState().entityById.get(sessionId));
