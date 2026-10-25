import type { PublicClass } from './public-availability'

// Presentation only. Keep API statuses, canRegister and capacity guards intact.
export function publicClassLabel(item: Pick<PublicClass, 'status' | 'canRegister'>): string {
  if (item.status === 'クラス受付停止中') return '満席'
  if (item.status === '残席確認不可') return '申込状況を確認できません'
  return item.canRegister ? '受付可能' : '申込不可'
}
