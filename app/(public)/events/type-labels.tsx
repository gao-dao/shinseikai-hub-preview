import styles from './guide.module.css'

export default function TypeLabels({ label }: { label: string | null | undefined }) {
  const types = label === '稽古会・一般参加' ? ['稽古会', '一般参加'] : label === '稽古会' || label === '一般参加' ? [label] : []
  if (!types.length) return null
  return <span className={styles.typeLabels}>{types.map(type =>
    <span key={type} className={`${styles.typeLabel} ${type === '稽古会' ? styles.practiceType : styles.openType}`}>{type}</span>
  )}</span>
}
