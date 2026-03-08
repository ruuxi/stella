export type PersonalPage = {
  pageId: string
  panelName: string
  title: string
  order: number
}

export type DialogType = 'auth' | 'connect' | 'settings' | 'test' | 'trace' | null
