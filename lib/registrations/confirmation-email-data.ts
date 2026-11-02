import 'server-only'
export type ConfirmationClass = { id: number; event_group_id: number; title: string; date: string; start_time: string | null; end_time: string | null; location: string }
export type ConfirmationDetails = { title: string; classes: ConfirmationClass[] }

export async function loadConfirmationDetails(groupId: number, ids: number[], url: string, key: string, signal: AbortSignal, fetcher: typeof fetch): Promise<ConfirmationDetails> {
  const headers = { apikey: key } // Publishable credentials only: no visitor/session or privileged client.
  const read = async (table: string, params: URLSearchParams): Promise<unknown> => {
    const response = await fetcher(`${url}/rest/v1/${table}?${params}`, { headers, signal, cache: 'no-store', credentials: 'omit' })
    if (!response.ok) throw new Error('EMAIL_METADATA_UNAVAILABLE')
    return response.json()
  }
  const [groups, classes] = await Promise.all([
    read('event_groups', new URLSearchParams({ select: 'id,title', id: `eq.${groupId}`, is_hidden: 'eq.false', is_cancelled: 'eq.false' })),
    read('schedules', new URLSearchParams({ select: 'id,event_group_id,title,date,start_time,end_time,location', event_group_id: `eq.${groupId}`, id: `in.(${ids.join(',')})`, order: 'date.asc,start_time.asc,id.asc' })),
  ])
  if (!Array.isArray(groups) || groups.length !== 1 || groups[0].id !== groupId || typeof groups[0].title !== 'string' ||
      !Array.isArray(classes) || classes.length !== ids.length) throw new Error('EMAIL_METADATA_INCOMPLETE')
  const seen = new Set<number>()
  for (const row of classes) {
    if (!row || !ids.includes(row.id) || seen.has(row.id) || row.event_group_id !== groupId ||
        typeof row.title !== 'string' || typeof row.location !== 'string' || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
        ![row.start_time, row.end_time].every(value => value === null || (typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/.test(value)))) throw new Error('EMAIL_METADATA_INVALID')
    seen.add(row.id)
  }
  return { title: groups[0].title, classes: classes as ConfirmationClass[] }
}
