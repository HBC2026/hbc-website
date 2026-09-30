import { Money } from './Money';
import { fmtNum } from '@/lib/format';
import type { Employee } from '@/lib/types';

export function OtRule({ e, defMult }: { e: Employee; defMult: number }) {
  return e.ot_method === 'fixed'
    ? <><Money v={e.ot_rate ?? 0} /> / hr</>
    : <>{fmtNum(e.ot_rate ?? defMult, 2).replace(/0$/, '')}× hourly</>;
}
