import { btoa } from 'react-native-quick-base64'
import { storageDataPrefix } from '@/config/constant'
import { getData, saveData } from '@/plugins/storage'
import { getListMusics, overwriteListFull } from '@/core/list'
import listState from '@/store/list/state'
import { filterMusicList, fixNewMusicInfoQuality } from '@/utils'
import { getUserApiList, getUserApiScript } from '@/utils/data'
import { importUserApi } from '@/core/userApi'
import { log } from '@/utils/log'


export interface WebDavSyncConfig {
  url: string
  username: string
  password: string
  syncUserApi: boolean
  syncList: boolean
}

const DEFAULT_CONFIG: WebDavSyncConfig = {
  url: '',
  username: '',
  password: '',
  syncUserApi: true,
  syncList: true,
}

interface WebDavSyncData {
  type: 'webdavSync'
  time: number
  data: {
    playList?: Array<LX.List.MyDefaultListInfoFull | LX.List.MyLoveListInfoFull | LX.List.UserListInfoFull>
    userApi?: Array<{ info: LX.UserApi.UserApiInfo, script: string }>
  }
}

const SYNC_DIR_NAME = 'lxmusic'
const SYNC_FILE_NAME = 'lx_music_sync.json'
const REQUEST_TIMEOUT = 30000

const configKey = storageDataPrefix.webdavSyncConfig

let cachedConfig: WebDavSyncConfig | null = null
export const getWebDavSyncConfig = async(): Promise<WebDavSyncConfig> => {
  if (cachedConfig === null) {
    // eslint-disable-next-line require-atomic-updates
    cachedConfig = { ...DEFAULT_CONFIG, ...(await getData<Partial<WebDavSyncConfig>>(configKey) ?? {}) }
  }
  return { ...cachedConfig }
}
export const saveWebDavSyncConfig = async(config: Partial<WebDavSyncConfig>) => {
  const oldConfig = await getWebDavSyncConfig()
  cachedConfig = { ...oldConfig, ...config }
  await saveData(configKey, cachedConfig)
}


// 同步数据固定存放在配置地址下的 lxmusic 子目录（坚果云等服务的根目录不允许直接存放文件）
const buildSyncDirUrl = (url: string) => {
  const baseUrl = url.replace(/\/+$/, '')
  // 兼容旧配置：地址末尾已带 lxmusic 时不重复追加
  return baseUrl.endsWith(`/${SYNC_DIR_NAME}`) ? baseUrl : `${baseUrl}/${SYNC_DIR_NAME}`
}

const buildSyncFileUrl = (url: string) => `${buildSyncDirUrl(url)}/${SYNC_FILE_NAME}`

const getAuthHeaders = (config: WebDavSyncConfig): Record<string, string> => {
  return config.username || config.password
    ? { Authorization: `Basic ${btoa(`${config.username}:${config.password}`)}` }
    : {}
}

const request = async(url: string, config: WebDavSyncConfig, options: RequestInit = {}): Promise<Response> => {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT)
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { ...getAuthHeaders(config), ...(options.headers as Record<string, string> ?? {}) },
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

const getStatusErrorMessage = (status: number): string => {
  switch (status) {
    case 401: return global.i18n.t('setting_webdav_error_401')
    case 403: return global.i18n.t('setting_webdav_error_403')
    case 404: return global.i18n.t('setting_webdav_error_404')
    case 409: return global.i18n.t('setting_webdav_error_409')
    default: return `HTTP ${status}`
  }
}

const errorWithUrl = (msg: string, method: string, url: string) => {
  log.error(`WebDAV ${method} ${url} failed: ${msg}`)
  return new Error(`${msg} [${method} ${url}]`)
}

/**
 * 上传前用 PROPFIND 预校验服务器路径与凭据；部分服务器（如坚果云）不支持/不允许 MKCOL，
 * 因此目录创建失败不阻断流程，最终交给 PUT 报错，避免误报
 */
const ensureRemotePath = async(config: WebDavSyncConfig) => {
  // 集合（目录）的 PROPFIND 需要使用带尾部斜杠的 URL，否则部分服务器返回 404
  const baseUrl = `${buildSyncDirUrl(config.url)}/`
  const resp = await request(baseUrl, config, { method: 'PROPFIND', headers: { Depth: '0' } })
  if (resp.status == 401 || resp.status == 403) throw errorWithUrl(getStatusErrorMessage(resp.status), 'PROPFIND', baseUrl)
  if (resp.ok || resp.status == 400 || resp.status == 405) return
  if (resp.status == 404) {
    try {
      await request(baseUrl, config, { method: 'MKCOL' })
    } catch {
      // 忽略，交给 PUT 报错
    }
  }
}


const getAllLists = async() => {
  const lists = []
  lists.push(await getListMusics(listState.defaultList.id).then(musics => ({ ...listState.defaultList, list: musics })))
  lists.push(await getListMusics(listState.loveList.id).then(musics => ({ ...listState.loveList, list: musics })))

  for await (const list of listState.userList) {
    lists.push(await getListMusics(list.id).then(musics => ({ ...list, list: musics })))
  }

  return lists
}

const getAllUserApis = async() => {
  const apis: Array<{ info: LX.UserApi.UserApiInfo, script: string }> = []
  for (const api of await getUserApiList()) {
    const script = await getUserApiScript(api.id)
    if (!script) continue
    apis.push({ info: api, script })
  }
  return apis
}

/**
 * 上传本机数据到 WebDAV 服务器
 */
export const uploadSyncData = async(config: WebDavSyncConfig) => {
  await ensureRemotePath(config)

  const data: WebDavSyncData['data'] = {}
  if (config.syncList) data.playList = await getAllLists()
  if (config.syncUserApi) data.userApi = await getAllUserApis()

  const syncData: WebDavSyncData = { type: 'webdavSync', time: Date.now(), data }

  const resp = await request(buildSyncFileUrl(config.url), config, {
    method: 'PUT',
    body: JSON.stringify(syncData),
    headers: { 'Content-Type': 'application/json' },
  })
  if (!resp.ok) throw errorWithUrl(getStatusErrorMessage(resp.status), 'PUT', buildSyncFileUrl(config.url))
}


const applyListData = async(lists: WebDavSyncData['data']['playList']) => {
  if (!lists) return
  const allLists = await getAllLists()
  for (const list of lists) {
    try {
      const targetList = allLists.find(l => l.id == list.id)
      if (targetList) {
        targetList.list = filterMusicList(list.list).map(m => fixNewMusicInfoQuality(m))
      } else {
        const data = {
          name: list.name,
          id: list.id,
          list: filterMusicList(list.list).map(m => fixNewMusicInfoQuality(m)),
          source: (list as LX.List.UserListInfoFull).source,
          sourceListId: (list as LX.List.UserListInfoFull).sourceListId,
          locationUpdateTime: (list as LX.List.UserListInfoFull).locationUpdateTime ?? null,
        }
        allLists.push(data as LX.List.UserListInfoFull)
      }
    } catch (err) {
      log.error('webdav sync apply list error:', err)
    }
  }
  const defaultList = allLists.shift()!.list
  const loveList = allLists.shift()!.list
  await overwriteListFull({ defaultList, loveList, userList: allLists as LX.List.UserListInfoFull[] })
}

const applyUserApiData = async(apis: WebDavSyncData['data']['userApi']) => {
  if (!apis?.length) return
  const localApis = await getUserApiList()
  for (const { info, script } of apis) {
    // 本机已存在同名同版本的自定义源时跳过，避免重复导入
    if (localApis.some(api => api.name == info.name && api.version == info.version)) continue
    try {
      await importUserApi(script)
    } catch (err) {
      log.error('webdav sync import user api error:', err)
    }
  }
}

/**
 * 从 WebDAV 服务器下载数据并恢复到本机
 */
export const downloadSyncData = async(config: WebDavSyncConfig) => {
  const fileUrl = buildSyncFileUrl(config.url)
  const resp = await request(fileUrl, config, { method: 'GET' })
  if (resp.status == 404) throw errorWithUrl(global.i18n.t('setting_webdav_file_not_found'), 'GET', fileUrl)
  if (!resp.ok) throw errorWithUrl(getStatusErrorMessage(resp.status), 'GET', fileUrl)
  const syncData = JSON.parse(await resp.text()) as WebDavSyncData
  if (syncData.type != 'webdavSync') throw new Error('Invalid WebDAV sync file')
  if (config.syncList) await applyListData(syncData.data.playList)
  if (config.syncUserApi) await applyUserApiData(syncData.data.userApi)
}
