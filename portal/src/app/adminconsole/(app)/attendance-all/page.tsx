'use client';
import { DailyAttendance } from '@/components/DailyAttendance';
import { PageHead } from '@/components/ui';

// Daily attendance for the employees of every company you belong to, on one screen.
export default function AllAttendancePage() {
  return (
    <>
      <PageHead eyebrow="Payroll" title="All Attendance" sub="Mark attendance for the employees of all your companies in one place." />
      <DailyAttendance all />
    </>
  );
}
