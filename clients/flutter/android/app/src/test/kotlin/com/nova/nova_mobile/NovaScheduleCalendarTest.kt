package com.nova.nova_mobile
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
class NovaScheduleCalendarTest {
 @Test fun daylightTransitionsAndFractionalOffsets() {
  val cases = listOf(
   listOf("America/New_York","2026-03-08","02:30","gap_at","2026-03-08T07:00:00Z"),
   listOf("America/New_York","2026-11-01","01:30","instant","2026-11-01T05:30:00Z"),
   listOf("Australia/Lord_Howe","2026-10-04","02:15","gap_at","2026-10-03T15:30:00Z"),
   listOf("Asia/Kathmandu","2026-10-17","09:00","instant","2026-10-17T03:15:00Z"))
  for (c in cases) assertEquals(c.toString(), Instant.parse(c[4]).toEpochMilli(), NovaScheduleCalendar.resolve(c[0],c[1],c[2])[c[3]])
 }
}
