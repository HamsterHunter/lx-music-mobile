import { memo, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'

import Section from '../../components/Section'
import SubTitle from '../../components/SubTitle'
import Button from '../../components/Button'
import CheckBoxItem from '../../components/CheckBoxItem'
import InputItem from '../../components/InputItem'
import { useI18n } from '@/lang'
import { confirmDialog, createStyle, toast } from '@/utils/tools'
import {
  downloadSyncData,
  getWebDavSyncConfig,
  saveWebDavSyncConfig,
  uploadSyncData,
  type WebDavSyncConfig,
} from '@/core/webdavSync'

const urlRxp = /^https?:\/\/\S+/i

export default memo(() => {
  const t = useI18n()
  const isUnmountedRef = useRef(true)
  const [config, setConfig] = useState<WebDavSyncConfig | null>(null)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    isUnmountedRef.current = false
    void getWebDavSyncConfig().then(config => {
      if (isUnmountedRef.current) return
      setConfig(config)
    })
    return () => {
      isUnmountedRef.current = true
    }
  }, [])

  const handleUpdateConfig = (config: Partial<WebDavSyncConfig>) => {
    setConfig(old => {
      if (old === null) return old
      const newConfig = { ...old, ...config }
      void saveWebDavSyncConfig(config)
      return newConfig
    })
  }

  const handleChangeUrl = (url: string, callback: (value: string) => void) => {
    let urlValue = ''
    if (urlRxp.test(url)) {
      urlValue = url.trim()
    } else if (url.trim()) {
      toast(t('setting_webdav_url_error_tip'), 'long')
    }
    callback(urlValue)
    handleUpdateConfig({ url: urlValue })
  }

  const handleSyncData = async(action: 'upload' | 'download') => {
    if (config === null || syncing) return
    if (!urlRxp.test(config.url)) {
      toast(t('setting_webdav_not_configured'))
      return
    }
    if (!config.syncUserApi && !config.syncList) {
      toast(t('setting_webdav_content_empty_tip'))
      return
    }
    if (action == 'download' && !await confirmDialog({
      message: t('setting_webdav_download_confirm'),
      cancelButtonText: t('dialog_cancel'),
      confirmButtonText: t('confirm_button_text'),
      bgClose: false,
    })) return
    setSyncing(true)
    toast(t(action == 'upload' ? 'setting_webdav_upload_tip_unsync' : 'setting_webdav_download_tip_unsync'))
    try {
      if (action == 'upload') await uploadSyncData(config)
      else await downloadSyncData(config)
      toast(t(action == 'upload' ? 'setting_webdav_upload_tip_success' : 'setting_webdav_download_tip_success'))
    } catch (error: any) {
      const errorMessage = error.name === 'AbortError' ? t('setting_webdav_error_timeout') : error.message as string
      toast(t(action == 'upload' ? 'setting_webdav_upload_tip_failed' : 'setting_webdav_download_tip_failed', { error: errorMessage }), 'long')
    }
    setSyncing(false)
  }

  return (
    <Section title={t('setting_webdav')}>
      <SubTitle title={t('setting_webdav_desc')}>
        <View style={styles.list}>
          <Button onPress={() => { void handleSyncData('upload') }} disabled={syncing || config === null}>{t('setting_webdav_upload')}</Button>
          <Button onPress={() => { void handleSyncData('download') }} disabled={syncing || config === null}>{t('setting_webdav_download')}</Button>
        </View>
      </SubTitle>
      <SubTitle title={t('setting_webdav_config')}>
        {
          config !== null ? (
            <>
              <InputItem
                value={config.url}
                label={t('setting_webdav_url')}
                onChanged={handleChangeUrl}
                inputMode="url"
                placeholder={t('setting_webdav_url_tip')} />
              <InputItem
                value={config.username}
                label={t('setting_webdav_username')}
                onChanged={text => { handleUpdateConfig({ username: text.trim() }) }}
                autoCapitalize="none"
                placeholder={t('setting_webdav_username')} />
              <InputItem
                value={config.password}
                label={t('setting_webdav_password')}
                onChanged={text => { handleUpdateConfig({ password: text.trim() }) }}
                autoCapitalize="none"
                secureTextEntry
                placeholder={t('setting_webdav_password')} />
            </>
          ) : null
        }
      </SubTitle>
      <SubTitle title={t('setting_webdav_content')}>
        {
          config !== null ? (
            <>
              <CheckBoxItem check={config.syncUserApi} label={t('setting_webdav_sync_user_api')} onChange={syncUserApi => { handleUpdateConfig({ syncUserApi }) }} />
              <CheckBoxItem check={config.syncList} label={t('setting_webdav_sync_list')} onChange={syncList => { handleUpdateConfig({ syncList }) }} />
            </>
          ) : null
        }
      </SubTitle>
    </Section>
  )
})

const styles = createStyle({
  list: {
    flexDirection: 'row',
  },
})
