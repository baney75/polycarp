.pragma library

// The clock's words and a month as rows of days, from plain numbers. Months are 0 to 11 and weekdays 0 (Sunday) to 6, as
// in JavaScript and Qt.


function step(year, month, months) {
  var at = year * 12 + month + months
  return { year: Math.floor(at / 12), month: ((at % 12) + 12) % 12 }
}

function weekdays(first) {
  var out = []
  for (var i = 0; i < 7; i++) out.push((first + i) % 7)
  return out
}

// Six rows whatever the month, so the panel keeps its height.
function days(year, month, first, today) {
  var start = new Date(Date.UTC(year, month, 1))
  var lead = (start.getUTCDay() - first + 7) % 7
  var out = []
  for (var i = 0; i < 42; i++) {
    var d = new Date(Date.UTC(year, month, 1 - lead + i))
    var weekday = d.getUTCDay()
    out.push({
      year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(),
      inMonth: d.getUTCMonth() === month,
      weekend: weekday === 0 || weekday === 6,
      today: today.year === d.getUTCFullYear() && today.month === d.getUTCMonth() && today.day === d.getUTCDate()
    })
  }
  return out
}

// "auto" follows the region's own short time.
function twelveHour(setting, shortFormat) {
  if (setting === "12") return true
  if (setting === "24") return false
  return /a/i.test(String(shortFormat))
}

function time(hours, minutes, twelve) {
  var two = function(n) { return (n < 10 ? "0" : "") + n }
  if (!twelve) return { hour: two(hours), minute: two(minutes), half: "" }
  return { hour: String(hours % 12 === 0 ? 12 : hours % 12), minute: two(minutes), half: hours < 12 ? "AM" : "PM" }
}
