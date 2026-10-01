/** An average hold in the export's hours-and-minutes form ("18m", "3h 41m",
    "2d 05h"): two units at most, the smaller zero-padded, and anything under a
    minute as "<1m", the way `since` prints an age. */
export function holdDuration(seconds: number) {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, "0")}h`;
}
