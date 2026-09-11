import { Component } from 'react'
import Restore from 'react-restore'

import link from '../../../resources/link'
import Dropdown from '../../../resources/Components/Dropdown'
import KeyboardShortcutConfigurator from '../../../resources/Components/KeyboardShortcutConfigurator'

import styled from 'styled-components'

const EditShortcut = styled.div`
  position: absolute;
  top: 1px;
  bottom: 0px;
  left: calc(100% + 10px);
  background: var(--ghostC);
  height: 20px;
  width: 60px;
  border-radius: 10px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  text-transform: uppercase;
  font-size: 10px;
  font-weight: 500;
  * {
    pointer-events: none;
  }
`

const DocsLink = styled.div`
  background: var(--ghostC);
  height: 20px;
  min-width: 60px;
  padding: 0 10px;
  margin-right: 6px;
  margin-left: 12px;
  margin-top: 4px;
  border-radius: 10px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  text-transform: uppercase;
  font-size: 10px;
  font-weight: 500;
`

const ActionLink = styled(DocsLink)`
  margin-left: 0;
  margin-top: 8px;
  opacity: ${(props) => (props.$disabled ? 0.45 : 1)};
  pointer-events: ${(props) => (props.$disabled ? 'none' : 'auto')};
  background: ${(props) => (props.$accent ? 'var(--good)' : 'var(--ghostC)')};
  color: ${(props) => (props.$accent ? 'var(--goodOver)' : 'inherit')};
`

const CMC_QUOTES_LATEST_DOCS = 'https://coinmarketcap.com/api/documentation/guides/get-latest-crypto-prices'
const isDev = process.env.NODE_ENV === 'development'

function cmcSavedKeyHint(last4) {
  return last4 ? `Saved on this machine ····${last4}` : 'Saved on this machine'
}

class Settings extends Component {
  constructor(props, context) {
    super(props, context)
    const latticeEndpoint = context.store('main.latticeSettings.endpointCustom')
    const latticeEndpointMode = context.store('main.latticeSettings.endpointMode')
    this.state = {
      latticeEndpoint,
      latticeEndpointMode,
      resetConfirm: false,
      cmcKeyInput: '',
      cmcKeyDirty: false,
      cmcKeyStatus: { source: 'none' },
      cmcKeyError: '',
      cmcKeyBusy: false
    }
  }

  componentDidMount() {
    this.refreshCmcKeyStatus()
  }

  refreshCmcKeyStatus = async () => {
    try {
      const status = await link.invoke('tray:cmcKeyStatus')
      this.setState({ cmcKeyStatus: status && status.source ? status : { source: 'none' } })
    } catch (e) {
      this.setState((prev) => ({
        cmcKeyStatus: prev.cmcKeyStatus && prev.cmcKeyStatus.source ? prev.cmcKeyStatus : { source: 'none' },
        cmcKeyError: prev.cmcKeyError || 'Could not read CMC key status'
      }))
    }
  }

  saveCmcKey = async () => {
    if (this.state.cmcKeyBusy || this.state.cmcKeyStatus.source === 'env') return
    if (!this.state.cmcKeyDirty && this.state.cmcKeyStatus.source === 'settings') return

    const key = (this.state.cmcKeyInput || '').trim()
    if (!key) {
      this.setState({ cmcKeyError: 'Enter a CoinMarketCap API key' })
      return
    }

    this.setState({ cmcKeyBusy: true, cmcKeyError: '' })
    try {
      const result = await link.invoke('tray:setCmcApiKey', key)
      if (result && result.ok) {
        this.setState({
          cmcKeyInput: '',
          cmcKeyDirty: false,
          cmcKeyStatus: result.status || { source: 'settings' },
          cmcKeyBusy: false,
          cmcKeyError: ''
        })
        await this.refreshCmcKeyStatus()
        return
      }
      this.setState({
        cmcKeyBusy: false,
        cmcKeyError: (result && result.error) || 'Could not save API key',
        cmcKeyStatus: (result && result.status) || this.state.cmcKeyStatus
      })
      await this.refreshCmcKeyStatus()
    } catch (e) {
      this.setState({ cmcKeyBusy: false, cmcKeyError: 'Could not save API key' })
      await this.refreshCmcKeyStatus()
    }
  }

  clearCmcKey = async () => {
    if (this.state.cmcKeyBusy || this.state.cmcKeyStatus.source === 'env') return

    this.setState({ cmcKeyBusy: true, cmcKeyError: '', cmcKeyInput: '', cmcKeyDirty: true })
    try {
      const result = await link.invoke('tray:clearCmcApiKey')
      this.setState({
        cmcKeyInput: '',
        cmcKeyDirty: true,
        cmcKeyStatus: (result && result.status) || { source: 'none' },
        cmcKeyBusy: false,
        cmcKeyError: (result && result.error) || ''
      })
      await this.refreshCmcKeyStatus()
    } catch (e) {
      this.setState({
        cmcKeyBusy: false,
        cmcKeyDirty: true,
        cmcKeyError: 'Could not clear API key',
        cmcKeyStatus: { source: 'none' }
      })
      await this.refreshCmcKeyStatus()
    }
  }

  handleCmcKeyInputChange = (e) => {
    const value = e.target.value
    const source = (this.state.cmcKeyStatus && this.state.cmcKeyStatus.source) || 'none'
    const hint = cmcSavedKeyHint(this.state.cmcKeyStatus && this.state.cmcKeyStatus.last4)
    const hasSaved = source === 'settings'
    const dirty = this.state.cmcKeyDirty

    if (!dirty && hasSaved) {
      if (!value || value === hint || hint.startsWith(value)) {
        this.setState({ cmcKeyInput: '', cmcKeyDirty: false, cmcKeyError: '' })
        return
      }
      const draft = value.startsWith(hint) ? value.slice(hint.length) : value
      this.setState({ cmcKeyInput: draft, cmcKeyDirty: true, cmcKeyError: '' })
      return
    }

    if (hasSaved && value === '') {
      this.setState({ cmcKeyInput: '', cmcKeyDirty: false, cmcKeyError: '' })
      return
    }

    this.setState({ cmcKeyInput: value, cmcKeyDirty: true, cmcKeyError: '' })
  }

  inputLatticeEndpoint(e) {
    e.preventDefault()
    clearTimeout(this.inputLatticeTimeout)
    const value = e.target.value.replace(/\s+/g, '')
    this.setState({ latticeEndpoint: value })
    // TODO: Update to target specific Lattice device rather than global
    this.inputLatticeTimeout = setTimeout(
      () => link.send('tray:action', 'setLatticeEndpointCustom', this.state.latticeEndpoint),
      1000
    )
  }

  isCmcPriceApiEnabled() {
    const stored = this.store('main.cmcPriceApiEnabled')
    if (stored === true) return true
    if (stored === false) return false
    const source = (this.state.cmcKeyStatus && this.state.cmcKeyStatus.source) || 'none'
    return source !== 'none'
  }

  renderCmcKeyControls() {
    const { cmcKeyInput, cmcKeyDirty, cmcKeyStatus, cmcKeyError, cmcKeyBusy } = this.state
    const source = (cmcKeyStatus && cmcKeyStatus.source) || 'none'
    const last4 = cmcKeyStatus && cmcKeyStatus.last4
    const envLocked = source === 'env'
    const hasSaved = source === 'settings'
    const showHint = hasSaved && !cmcKeyDirty
    const hint = cmcSavedKeyHint(last4)
    const inputValue = showHint ? hint : cmcKeyInput
    const saveLabel = showHint ? 'Saved' : 'Save'

    const docs = (
      <ActionLink onClick={() => link.send('tray:openExternal', CMC_QUOTES_LATEST_DOCS)}>Docs</ActionLink>
    )

    if (envLocked) {
      return (
        <>
          <div style={{ marginTop: 8 }}>{'Using env (`CMC_API_KEY`)'}</div>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>{docs}</div>
        </>
      )
    }

    return (
      <>
        <div className='connectionCustomInput connectionCustomInputOn' style={{ position: 'relative' }}>
          <input
            type={showHint ? 'text' : 'password'}
            tabIndex='-1'
            autoComplete='off'
            spellCheck='false'
            placeholder='CoinMarketCap API key'
            value={inputValue}
            disabled={cmcKeyBusy}
            onChange={this.handleCmcKeyInputChange}
            onFocus={(e) => {
              if (showHint) e.target.select()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') this.saveCmcKey()
            }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
          <ActionLink $disabled={cmcKeyBusy} $accent={cmcKeyDirty} onClick={this.saveCmcKey}>
            {saveLabel}
          </ActionLink>
          <ActionLink $disabled={cmcKeyBusy} onClick={this.clearCmcKey}>
            Clear
          </ActionLink>
          {docs}
        </div>
        {source === 'none' ? <div style={{ marginTop: 6 }}>{'No key — price feed off'}</div> : null}
        {cmcKeyError ? <div style={{ marginTop: 6 }}>{cmcKeyError}</div> : null}
      </>
    )
  }

  render() {
    const summonShortcut = this.store('main.shortcuts.summon')
    const platform = this.store('platform')

    return (
      <div className={'localSettings cardShow'}>
        <div className='localSettingsWrap'>
          <div className='signerPermission localSetting' style={{ zIndex: 215 }}>
            <div className='signerPermissionControls'>
              <div className='signerPermissionSetting'>Pylon RPC</div>
              <div
                className={
                  this.store('main.pylonEnabled') !== false
                    ? 'signerPermissionToggle signerPermissionToggleOn'
                    : 'signerPermissionToggle'
                }
                onClick={() =>
                  link.send('tray:action', 'setPylonEnabled', this.store('main.pylonEnabled') === false)
                }
              >
                <div className='signerPermissionToggleSwitch' />
              </div>
            </div>
            <div className='signerPermissionDetails'>
              {'Use Pylon as the default RPC preset. Disable if Pylon endpoints are unreachable or causing connection issues.'}
            </div>
          </div>
          <div className='signerPermission localSetting' style={{ zIndex: 214 }}>
            <div className='signerPermissionControls'>
              <div className='signerPermissionSetting'>Public RPC</div>
              <div
                className={
                  this.store('main.publicEndpointsEnabled')
                    ? 'signerPermissionToggle signerPermissionToggleOn'
                    : 'signerPermissionToggle'
                }
                onClick={() =>
                  link.send('tray:action', 'setPublicEndpointsEnabled', !this.store('main.publicEndpointsEnabled'))
                }
              >
                <div className='signerPermissionToggleSwitch' />
              </div>
            </div>
            <div className='signerPermissionDetails'>
              {'Make public RPC endpoints an option. Public endpoints are operated by third parties — they receive your IP address & request data. Only enable accept these privacy tradeoffs.'}
            </div>
          </div>
          <div className='signerPermission localSetting' style={{ zIndex: 213 }}>
            <div className='signerPermissionControls'>
              <div className='signerPermissionSetting'>CMC Price API</div>
              <div
                className={
                  this.isCmcPriceApiEnabled()
                    ? 'signerPermissionToggle signerPermissionToggleOn'
                    : 'signerPermissionToggle'
                }
                onClick={() =>
                  link.send('tray:action', 'setCmcPriceApiEnabled', !this.isCmcPriceApiEnabled())
                }
              >
                <div className='signerPermissionToggleSwitch' />
              </div>
            </div>
            <div className='signerPermissionDetails' style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div>
                {
                  'Bring your own CoinMarketCap API key so Frame Fork can fetch token and native USD prices.'
                }
                {isDev ? ' CMC_API_KEY env var wins over a key saved here.' : null}
              </div>
              {this.isCmcPriceApiEnabled() ? this.renderCmcKeyControls() : null}
            </div>
          </div>
          <div className='signerPermission localSetting' style={{ zIndex: 213 }}>
            <div className='signerPermissionControls'>
              <div className='signerPermissionSetting'>
                <span style={{ position: 'relative' }}>
                  Summon Shortcut
                  <div>
                    {summonShortcut.configuring ? (
                      <EditShortcut
                        onClick={() => {
                          link.send('tray:action', 'setShortcut', 'summon', {
                            ...summonShortcut,
                            configuring: false
                          })
                        }}
                      >
                        cancel
                      </EditShortcut>
                    ) : (
                      <EditShortcut
                        onClick={() => {
                          link.send('tray:action', 'setShortcut', 'summon', {
                            ...summonShortcut,
                            configuring: true
                          })
                        }}
                      >
                        edit
                      </EditShortcut>
                    )}
                  </div>
                </span>
              </div>

              <div
                className={
                  summonShortcut.enabled
                    ? 'signerPermissionToggle signerPermissionToggleOn'
                    : 'signerPermissionToggle'
                }
                onClick={() => {
                  link.send('tray:action', 'setShortcut', 'summon', {
                    ...summonShortcut,
                    enabled: !summonShortcut.enabled
                  })
                }}
              >
                <div className='signerPermissionToggleSwitch' />
              </div>
            </div>
            <div className='signerPermissionDetails'>
              <KeyboardShortcutConfigurator
                actionText='summon Frame'
                shortcut={summonShortcut}
                shortcutName='summon'
                platform={platform}
              />
            </div>
          </div>
          <div className='signerPermission localSetting' style={{ zIndex: 213 }}>
            <div className='signerPermissionControls'>
              <div className='signerPermissionSetting'>Auto-hide</div>
              <div
                className={
                  this.store('main.autohide')
                    ? 'signerPermissionToggle signerPermissionToggleOn'
                    : 'signerPermissionToggle'
                }
                onClick={() => link.send('tray:action', 'setAutohide', !this.store('main.autohide'))}
              >
                <div className='signerPermissionToggleSwitch' />
              </div>
            </div>
            <div className='signerPermissionDetails'>
              <span>Hide Frame on loss of focus</span>
            </div>
          </div>
          <div className='signerPermission localSetting' style={{ zIndex: 212 }}>
            <div className='signerPermissionControls'>
              <div className='signerPermissionSetting'>Run on Startup</div>
              <div
                className={
                  this.store('main.launch')
                    ? 'signerPermissionToggle signerPermissionToggleOn'
                    : 'signerPermissionToggle'
                }
                onClick={() => link.send('tray:action', 'toggleLaunch')}
              >
                <div className='signerPermissionToggleSwitch' />
              </div>
            </div>
            <div className='signerPermissionDetails'>Run Frame when your computer starts</div>
          </div>
          <div className='signerPermission localSetting' style={{ zIndex: 211 }}>
            <div className='signerPermissionControls'>
              <div className='signerPermissionSetting'>Glide</div>
              <div
                className={
                  this.store('main.reveal')
                    ? 'signerPermissionToggle signerPermissionToggleOn'
                    : 'signerPermissionToggle'
                }
                onClick={() => link.send('tray:action', 'toggleReveal')}
              >
                <div className='signerPermissionToggleSwitch' />
              </div>
            </div>
            <div className='signerPermissionDetails'>{"Mouse to display's right edge to summon Frame"}</div>
          </div>

          {this.store('platform') === 'darwin' ? (
            <div className='signerPermission localSetting' style={{ zIndex: 210 }}>
              <div className='signerPermissionControls'>
                <div className='signerPermissionSetting'>Display Gas in Menubar</div>
                <div
                  className={
                    this.store('main.menubarGasPrice')
                      ? 'signerPermissionToggle signerPermissionToggleOn'
                      : 'signerPermissionToggle'
                  }
                  onClick={() =>
                    link.send('tray:action', 'setMenubarGasPrice', !this.store('main.menubarGasPrice'))
                  }
                >
                  <div className='signerPermissionToggleSwitch' />
                </div>
              </div>
              <div className='signerPermissionDetails'>Show mainnet gas price (Gwei) in menubar</div>
            </div>
          ) : null}

          <div className='signerPermission localSetting' style={{ zIndex: 209 }}>
            <div className='signerPermissionControls'>
              <div className='signerPermissionSetting'>Error Reporting</div>
              <div
                className={
                  this.store('main.privacy.errorReporting')
                    ? 'signerPermissionToggle signerPermissionToggleOn'
                    : 'signerPermissionToggle'
                }
                onClick={() =>
                  link.send('tray:action', 'setErrorReporting', !this.store('main.privacy.errorReporting'))
                }
              >
                <div className='signerPermissionToggleSwitch' />
              </div>
            </div>
            <div className='signerPermissionDetails'>
              <span>Help improve Frame by anonymously reporting errors</span>
            </div>
          </div>

          <div className='signerPermission localSetting' style={{ zIndex: 207 }}>
            <div className='signerPermissionControls'>
              <div className='signerPermissionSetting'>Show Account Name with ENS</div>
              <div
                className={
                  this.store('main.showLocalNameWithENS')
                    ? 'signerPermissionToggle signerPermissionToggleOn'
                    : 'signerPermissionToggle'
                }
                onClick={() => {
                  link.send('tray:action', 'toggleShowLocalNameWithENS')
                }}
              >
                <div className='signerPermissionToggleSwitch' />
              </div>
            </div>
            <div className='signerPermissionDetails'>{'Show local account name when ENS is resolved'}</div>
          </div>

          <div className='signerPermission localSetting' style={{ zIndex: 206 }}>
            <div className='signerPermissionControls'>
              <div className='signerPermissionSetting'>Colorway</div>
              <Dropdown
                syncValue={this.store('main.colorway')}
                onChange={(value) => link.send('tray:action', 'setColorway', value)}
                options={[
                  { text: 'Dark', value: 'dark' },
                  { text: 'Light', value: 'light' }
                ]}
              />
            </div>
            <div className='signerPermissionDetails'>
              <span>Set Frame&apos;s visual theme</span>
            </div>
          </div>

          <div className='signerPermission localSetting' style={{ zIndex: 205 }}>
            <div className='signerPermissionControls'>
              <div className='signerPermissionSetting'>Trezor Derivation</div>
              <Dropdown
                syncValue={this.store('main.trezor.derivation')}
                onChange={(value) => link.send('tray:action', 'setTrezorDerivation', value)}
                options={[
                  { text: 'Standard', value: 'standard' },
                  { text: 'Legacy', value: 'legacy' },
                  { text: 'Testnet', value: 'testnet' }
                ]}
              />
            </div>
            <div className='signerPermissionDetails'>{'Derivation path for connected Trezor devices'}</div>
          </div>
          <div className='signerPermission localSetting' style={{ zIndex: 204 }}>
            <div className='signerPermissionControls'>
              <div className='signerPermissionSetting'>Ledger Derivation</div>
              <Dropdown
                syncValue={this.store('main.ledger.derivation')}
                onChange={(value) => link.send('tray:action', 'setLedgerDerivation', value)}
                options={[
                  { text: 'Live', value: 'live' },
                  { text: 'Legacy', value: 'legacy' },
                  { text: 'Standard', value: 'standard' },
                  { text: 'Testnet', value: 'testnet' }
                ]}
              />
            </div>
            <div className='signerPermissionDetails'>{'Derivation path for connected Ledger devices'}</div>
          </div>
          {this.store('main.ledger.derivation') === 'live' ? (
            <div className='signerPermission localSetting' style={{ zIndex: 203 }}>
              <div className='signerPermissionControls'>
                <div className='signerPermissionSetting'>Ledger Live Accounts</div>
                <Dropdown
                  syncValue={this.store('main.ledger.liveAccountLimit')}
                  onChange={(value) => link.send('tray:action', 'setLiveAccountLimit', value)}
                  options={[
                    { text: '5', value: 5 },
                    { text: '10', value: 10 },
                    { text: '20', value: 20 },
                    { text: '40', value: 40 }
                  ]}
                />
              </div>
              <div className='signerPermissionDetails'>The number of live accounts to derive</div>
            </div>
          ) : null}
          <div className='signerPermission localSetting' style={{ zIndex: 202 }}>
            <div className='signerPermissionControls'>
              <div className='signerPermissionSetting'>Lattice Derivation</div>
              <Dropdown
                syncValue={this.store('main.latticeSettings.derivation')}
                onChange={(value) => link.send('tray:action', 'setLatticeDerivation', value)}
                options={[
                  { text: 'Standard', value: 'standard' },
                  { text: 'Legacy', value: 'legacy' },
                  { text: 'Live', value: 'live' }
                ]}
              />
            </div>
            <div className='signerPermissionDetails'>{'Derivation path for connected Lattice devices'}</div>
          </div>
          <div className='signerPermission localSetting' style={{ zIndex: 201 }}>
            <div className='signerPermissionControls'>
              <div className='signerPermissionSetting'>Lattice Accounts</div>
              <Dropdown
                syncValue={this.store('main.latticeSettings.accountLimit')}
                onChange={(value) => link.send('tray:action', 'setLatticeAccountLimit', value)}
                options={[
                  { text: '5', value: 5 },
                  { text: '10', value: 10 },
                  { text: '20', value: 20 },
                  { text: '40', value: 40 }
                ]}
              />
            </div>
            <div className='signerPermissionDetails'>The number of lattice accounts to derive</div>
          </div>
          <div className='signerPermission localSetting' style={{ zIndex: 200 }}>
            <div className='signerPermissionControls'>
              <div className='signerPermissionSetting'>Lattice Relay</div>
              <Dropdown
                syncValue={this.store('main.latticeSettings.endpointMode')}
                onChange={(value) => {
                  link.send('tray:action', 'setLatticeEndpointMode', value)
                  this.setState({ latticeEndpointMode: value })
                }}
                options={[
                  { text: 'Default', value: 'default' },
                  { text: 'Custom', value: 'custom' }
                ]}
              />
            </div>
            <div
              className={
                this.state.latticeEndpointMode === 'custom'
                  ? 'connectionCustomInput connectionCustomInputOn'
                  : 'connectionCustomInput'
              }
            >
              <input
                tabIndex='-1'
                placeholder={'Custom Relay'}
                value={this.state.latticeEndpoint}
                onChange={(e) => this.inputLatticeEndpoint(e)}
              />
            </div>
          </div>

          <div className='signerPermission localSetting' style={{ zIndex: 199 }}>
            <div className='signerPermissionControls'>
              <div className='signerPermissionSetting'>Lock Hot Signers on</div>
              <Dropdown
                syncValue={this.store('main.accountCloseLock')}
                onChange={(value) => link.send('tray:action', 'setAccountCloseLock', value)}
                options={[
                  { text: 'Close', value: true },
                  { text: 'Quit', value: false }
                ]}
              />
            </div>
            <div className='signerPermissionDetails'>When should Frame relock your hot signers?</div>
          </div>
        </div>
      </div>
    )
  }
}

export default Restore.connect(Settings)
