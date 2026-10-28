import {
  type Component,
  type Focusable,
  fuzzyFilter,
  Input,
  matchesKey,
  type SelectItem,
  SelectList,
  type SelectListTheme,
} from '@earendil-works/pi-tui'

const LIST_KEYS = [
  'up',
  'down',
  'enter',
  'escape',
  'pageUp',
  'pageDown',
] as const

/** A select list with a search line above it (like pi's model selector): typing filters, arrows and Enter pick. */
export class SearchSelect implements Component, Focusable {
  private readonly input = new Input({ prompt: 'Search: ' })
  private list: SelectList
  private query = ''
  onSelect?: (item: SelectItem) => void
  onCancel?: () => void

  constructor(
    private readonly items: SelectItem[],
    private readonly maxVisible: number,
    private readonly theme: SelectListTheme,
    selected?: string,
  ) {
    this.list = this.build(items)
    const index = items.findIndex((item) => item.value === selected)
    if (index > 0) this.list.setSelectedIndex(index)
  }

  get focused(): boolean {
    return this.input.focused
  }

  set focused(value: boolean) {
    this.input.focused = value
  }

  private build(items: SelectItem[]): SelectList {
    const list = new SelectList(items, this.maxVisible, this.theme)
    list.onSelect = (item) => this.onSelect?.(item)
    list.onCancel = () => this.onCancel?.()
    return list
  }

  handleInput(data: string): void {
    if (LIST_KEYS.some((key) => matchesKey(data, key))) {
      this.list.handleInput(data)
      return
    }
    this.input.handleInput(data)
    const query = this.input.getValue().trim()
    if (query === this.query) return
    this.query = query
    this.list = this.build(
      query
        ? fuzzyFilter(
            this.items,
            query,
            (item) => `${item.value} ${item.description ?? ''}`,
          )
        : this.items,
    )
  }

  render(width: number): string[] {
    return [...this.input.render(width), ...this.list.render(width)]
  }

  invalidate(): void {
    this.input.invalidate()
    this.list.invalidate()
  }
}
