import { redirect } from 'next/navigation';

export default function AttendanceIndex() {
  redirect('/adminconsole/attendance/monthly?view=daily');
}
