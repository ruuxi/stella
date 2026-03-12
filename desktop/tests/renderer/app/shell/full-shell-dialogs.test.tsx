import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FullShellDialogs } from '../../../../src/shell/full-shell-dialogs'

describe('FullShellDialogs', () => {
  it('shows the reset messages dev control alongside onboarding and test controls', () => {
    const onResetMessages = vi.fn()
    const onResetOnboarding = vi.fn()
    const onShowTestDialog = vi.fn()
    const onShowTraceDialog = vi.fn()

    render(
      <FullShellDialogs
        activeDialog={null}
        isDev={true}
        onDialogOpenChange={vi.fn()}
        onResetMessages={onResetMessages}
        onSignOut={vi.fn()}
        onResetOnboarding={onResetOnboarding}
        onShowTestDialog={onShowTestDialog}
        onShowTraceDialog={onShowTraceDialog}
      />,
    )

    fireEvent.click(screen.getByText('Reset Messages'))
    fireEvent.click(screen.getByText('Reset Onboarding'))
    fireEvent.click(screen.getByText('Test UI'))
    fireEvent.click(screen.getByText('Trace'))

    expect(onResetMessages).toHaveBeenCalledTimes(1)
    expect(onResetOnboarding).toHaveBeenCalledTimes(1)
    expect(onShowTestDialog).toHaveBeenCalledTimes(1)
    expect(onShowTraceDialog).toHaveBeenCalledTimes(1)
  })
})

