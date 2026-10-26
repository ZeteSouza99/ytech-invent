import { beforeEach, describe, expect, it, vi } from 'vitest';
const fs = vi.hoisted(() => ({
  permission: vi.fn(), create: vi.fn(), write: vi.fn(), remove: vi.fn(),
}));
vi.mock('expo-file-system/legacy', () => ({
  StorageAccessFramework: { requestDirectoryPermissionsAsync: fs.permission, createFileAsync: fs.create },
  writeAsStringAsync: fs.write, deleteAsync: fs.remove, EncodingType: { Base64: 'base64' },
}));
import { saveWorkbookFiles } from '../src/exportFiles';
const attachments = ['SB1_Produtos.xlsx', 'Inventario_Ytech.xlsx'].map(filename => ({
  filename, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: new Uint8Array([0, 255, 20]),
}));

beforeEach(() => {
  vi.resetAllMocks();
  fs.permission.mockResolvedValue({ granted: true, directoryUri: 'content://chosen' });
  fs.create.mockImplementation(async (_directory, name) => `content://chosen/${name}`);
  fs.write.mockResolvedValue(undefined);
  fs.remove.mockResolvedValue(undefined);
});

describe('exportação independente do Gmail', () => {
  it('cancelar a escolha da pasta não cria arquivos', async () => {
    fs.permission.mockResolvedValue({ granted: false });
    expect(await saveWorkbookFiles(attachments, 'id', false)).toBeNull();
    expect(fs.create).not.toHaveBeenCalled();
  });
  it('salva as duas planilhas e identifica uma coleta parcial', async () => {
    const names = await saveWorkbookFiles(attachments, 'inventory-1', true);
    expect(names).toHaveLength(2);
    expect(names?.every(name => name.includes('PARCIAL_inventory-1_') && name.endsWith('.xlsx'))).toBe(true);
    expect(fs.write).toHaveBeenCalledTimes(2);
    expect(fs.write.mock.calls[0]?.[1]).toBe(Buffer.from(attachments[0]!.content).toString('base64'));
  });
  it('falha na segunda planilha remove somente os arquivos recém-criados', async () => {
    fs.write.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('sem espaço'));
    await expect(saveWorkbookFiles(attachments, 'id', false)).rejects.toThrow('A coleta continua no aplicativo');
    expect(fs.remove).toHaveBeenCalledTimes(2);
    expect(fs.remove.mock.calls.map(call => call[0])).toEqual(fs.create.mock.calls.map(call => `content://chosen/${call[1]}`));
  });
  it('avisa quando não foi possível limpar uma exportação incompleta', async () => {
    fs.write.mockRejectedValue(new Error('falha'));
    fs.remove.mockRejectedValue(new Error('sem permissão'));
    await expect(saveWorkbookFiles(attachments, 'id', false)).rejects.toThrow('arquivos incompletos');
  });
});
