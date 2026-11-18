/** `sms:` hand-off link with the last known location. The phone's own SMS app sends it, so it works with no data. */
export function smsLink(lat: number | null, lon: number | null, numbers: string[]) {
  const where = lat != null && lon != null ? `https://maps.google.com/?q=${lat},${lon}` : 'location unknown'
  return `sms:${numbers.join(',')}?body=${encodeURIComponent(`EMERGENCY - I need help. ${where}`)}`
}
