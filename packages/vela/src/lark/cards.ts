/** The fields used from a `card.action.trigger` callback (v2). */
export interface LarkCardAction {
  operator?: { open_id?: string }
  context?: { open_chat_id?: string }
  action?: { value?: unknown }
}

export interface LarkCardResponse {
  toast: { type: 'success' | 'info'; content: string }
}

export interface LarkCard {
  schema: '2.0'
  config?: { update_multi: true }
  header: { title: { tag: 'plain_text'; content: string } }
  body: {
    elements: {
      tag: 'markdown' | 'column_set'
      content?: string
      columns?: {
        tag: 'column'
        width: 'weighted'
        weight: number
        elements: {
          tag: 'button'
          text: { tag: 'plain_text'; content: string }
          type: 'primary' | 'default' | 'danger'
          behaviors: {
            type: 'callback'
            value: { action: string; token: string }
          }[]
        }[]
      }[]
    }[]
  }
}

export function runControlsCard(token: string): LarkCard {
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: 'A run is in progress' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            'Your message is queued by default. Steer adds it to the current task for one combined reply. Stop cancels the current run and discards this queued message.',
        },
        {
          tag: 'column_set',
          columns: (['queue', 'steer', 'stop'] as const).map((action) => ({
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [
              {
                tag: 'button',
                text: {
                  tag: 'plain_text',
                  content: {
                    queue: 'Queue (default)',
                    steer: 'Steer',
                    stop: 'Stop',
                  }[action],
                },
                type:
                  action === 'queue'
                    ? 'primary'
                    : action === 'stop'
                      ? 'danger'
                      : 'default',
                behaviors: [{ type: 'callback', value: { action, token } }],
              },
            ],
          })),
        },
      ],
    },
  }
}

export function topicRunCard(token: string): LarkCard {
  const card = runControlsCard(token)
  card.config = { update_multi: true }
  card.body.elements[0] = {
    tag: 'markdown',
    content:
      'Working on this topic. Stop keeps the conversation for your next message.',
  }
  const buttons = card.body.elements[1]
  if (buttons?.columns) buttons.columns = buttons.columns.slice(-1)
  return card
}
