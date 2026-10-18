package com.nova.nova_mobile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

object NovaScheduleCalendar {
    fun format(zone: String): SimpleDateFormat {
        require(TimeZone.getAvailableIDs().contains(zone))
        return SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.US).apply { timeZone = TimeZone.getTimeZone(zone); isLenient = false }
    }
    fun resolve(zone: String, day: String, time: String): Map<String, Long?> {
        val formatter = format(zone); val target = "${day}T$time"
        val utc = format("UTC"); val nominal = utc.parse(target)!!.time
        val offsets = (-48..48 step 6).map { hour ->
            val probe = nominal + hour * 3600000L
            utc.parse(formatter.format(Date(probe)))!!.time - probe
        }.toSet()
        val candidates = offsets.map { nominal - it }.sorted()
        val instant = candidates.firstOrNull { formatter.format(Date(it)) == target }
        if (instant != null) return mapOf("instant" to instant, "gap_at" to null)
        var probe = candidates.first()
        while (probe <= candidates.last()) {
            if (formatter.format(Date(probe)) >= target) return mapOf("instant" to null, "gap_at" to probe)
            probe += 60000
        }
        return mapOf("instant" to null, "gap_at" to candidates.last())
    }
}
