import * as SwitchPrimitive from '@radix-ui/react-switch'
import type { ComponentPropsWithoutRef } from 'react'
import { useId } from 'react'
import styles from './switch.module.css'

export interface SwitchProps
  extends ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  label: string
}

/** Native Vela pill switch matching design/vela-app.html (.switch). */
export function Switch({ label, className, id, ...props }: SwitchProps) {
  const autoId = useId()
  const switchId = id ?? autoId
  return (
    <div className={[styles.field, className].filter(Boolean).join(' ')}>
      <SwitchPrimitive.Root id={switchId} className={styles.track} {...props}>
        <SwitchPrimitive.Thumb className={styles.thumb} />
      </SwitchPrimitive.Root>
      <label className={styles.label} htmlFor={switchId}>
        {label}
      </label>
    </div>
  )
}
