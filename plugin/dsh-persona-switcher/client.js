/**
 * Browser half of dsh-persona-switcher: a persona picker docked above the
 * composer (`conversation.input.dock`). It reads the `personaSwitcher` Session
 * projection for the catalog and current selection, and switches by running
 * `/persona <id>` through the commands Remote API, so a click and a typed
 * command take the same path and leave the same record in the conversation.
 *
 * Hand-written in the module-loader format the Web client serves
 * (`window.__ModuleLoader__.load({ id, factory })`); it needs no build step.
 */
window.__ModuleLoader__.load({
  id: 'dsh-persona-switcher',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const h = React.createElement

    const styles = {
      dock: {
        boxSizing: 'border-box',
        width: 'calc(100% - 2 * var(--dsh-composer-side-clearance, 0px) - 4 * var(--dsh-composer-dock-inset, 0px))',
        margin: '0 auto',
      },
      bar: {
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        width: '100%',
        maxWidth: 'calc(var(--dsh-composer-card-max-width, 100%) - 4 * var(--dsh-composer-dock-inset, 0px))',
        minHeight: 36,
        margin: '0 auto',
        padding: '4px 6px 4px 12px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'var(--dsw-specific-menu)',
        boxShadow: 'var(--dsw-elevation-panel)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
      },
      label: { color: 'var(--dsw-alias-label-tertiary)', marginRight: 2, whiteSpace: 'nowrap' },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 26,
        padding: '0 10px',
        // Longhands only: React clears a removed longhand, which would wipe the color of a `border` shorthand.
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--dsw-alias-border-l1)',
        borderRadius: 13,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      active: {
        borderColor: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-interactive-bg-hover)',
        fontWeight: 600,
        cursor: 'default',
      },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, flexBasis: '100%' },
    }

    /**
     * Session-scoped dock entry. Renders nothing until the Session has been
     * offered a catalog with at least one installed persona.
     */
    function PersonaDock({ useProjection, selectPersona }) {
      const view = useProjection('personaSwitcher')
      const [pending, setPending] = React.useState(null)
      const [error, setError] = React.useState(null)
      if (view == null || view.catalog.length < 2) return null

      const currentId = view.selected === null ? 'default' : view.selected.id
      const choose = async (id) => {
        if (id === currentId || pending !== null) return
        setPending(id)
        setError(null)
        try {
          const failure = await selectPersona(id)
          if (failure !== null) setError(failure)
        } finally {
          setPending(null)
        }
      }

      return h('div', { style: styles.dock },
        h('div', { style: styles.bar, role: 'radiogroup', 'aria-label': 'Persona' },
          h('span', { style: styles.label }, 'Persona'),
          ...view.catalog.map((persona) => {
            const active = persona.id === currentId
            return h('button', {
              key: persona.id,
              type: 'button',
              role: 'radio',
              'aria-checked': active,
              title: persona.description || persona.name,
              disabled: pending !== null && !active,
              style: active ? { ...styles.chip, ...styles.active } : styles.chip,
              onClick: () => { void choose(persona.id) },
            }, `${persona.icon} ${persona.name}${pending === persona.id ? ' …' : ''}`)
          }),
          error === null ? null : h('span', { style: styles.error, role: 'alert' }, error),
        ))
    }

    const inject = ['slots', 'remote', 'remote.commands']

    function apply(ctx) {
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'persona-switcher',
        order: 5,
        inject: sessionId => ({
          /** @returns {Promise<string | null>} null on success, otherwise a line to show the user. */
          selectPersona: async (personaId) => {
            const result = await ctx.remote.commands.execute(sessionId, `/persona ${personaId}`, [])
            if (!result.ok) return `${result.error.message} (${result.error.code})`
            if (result.value === undefined) return 'The /persona command is not installed on this host.'
            return result.value.result.kind === 'error' ? result.value.result.text : null
          },
        }),
      }, PersonaDock))
    }

    exports.PersonaDock = PersonaDock
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
