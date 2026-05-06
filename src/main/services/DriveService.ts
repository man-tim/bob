import { google } from 'googleapis'
import { AuthService } from '../auth/AuthService'
import { DRIVE_ROOT_FOLDER_NAME, DRIVE_ARCHIVE_FOLDER_NAME } from '@shared/constants'

interface DriveFile {
  id: string
  name: string
  parents: string[]
}

export const DriveService = {
  async _drive() {
    const auth = await AuthService.getAuthClient()
    return google.drive({ version: 'v3', auth })
  },

  /**
   * Find or create a folder by name under an optional parent.
   */
  async ensureFolder(name: string, parentId?: string): Promise<string> {
    const drive = await this._drive()

    const q = [
      `name = '${name.replace(/'/g, "\\'")}'`,
      "mimeType = 'application/vnd.google-apps.folder'",
      'trashed = false',
    ]
    if (parentId) q.push(`'${parentId}' in parents`)

    const res = await drive.files.list({
      q: q.join(' and '),
      fields: 'files(id,name)',
      spaces: 'drive',
    })

    if (res.data.files?.length) {
      return res.data.files[0].id!
    }

    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : [],
      },
      fields: 'id',
    })

    return created.data.id!
  },

  /**
   * Upload a text file to a specific Drive folder.
   */
  async uploadTranscript(content: string, filename: string, folderId: string): Promise<DriveFile> {
    const drive = await this._drive()

    const res = await drive.files.create({
      requestBody: {
        name:    filename,
        parents: [folderId],
      },
      media: {
        mimeType: 'text/plain',
        body:     content,
      },
      fields: 'id,name,parents',
    })

    return {
      id:      res.data.id!,
      name:    res.data.name!,
      parents: res.data.parents ?? [],
    }
  },

  /**
   * Move a file to a different parent folder.
   */
  async moveFile(fileId: string, newParentId: string, oldParentId?: string): Promise<void> {
    const drive = await this._drive()

    await drive.files.update({
      fileId,
      addParents:    newParentId,
      removeParents: oldParentId,
      fields: 'id,parents',
    })
  },

  /**
   * List files in a folder.
   */
  async listFilesInFolder(folderId: string): Promise<DriveFile[]> {
    const drive = await this._drive()

    const res = await drive.files.list({
      q:      `'${folderId}' in parents and trashed = false`,
      fields: 'files(id,name,parents)',
      spaces: 'drive',
    })

    return (res.data.files ?? []).map(f => ({
      id:      f.id!,
      name:    f.name!,
      parents: f.parents ?? [],
    }))
  },

  /**
   * Get or create the root "Gong Uploads" folder and archive subfolder.
   */
  async ensureRootFolders(): Promise<{ rootId: string; archiveId: string }> {
    const rootId    = await this.ensureFolder(DRIVE_ROOT_FOLDER_NAME)
    const archiveId = await this.ensureFolder(DRIVE_ARCHIVE_FOLDER_NAME, rootId)
    return { rootId, archiveId }
  },
}
