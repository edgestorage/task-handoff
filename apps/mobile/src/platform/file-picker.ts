import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

export type MobileLocalFile = {
  uri: string;
  name: string;
  mime: string | undefined;
  size: number | undefined;
  kind: 'image' | 'file';
  temporary?: boolean;
};

export async function pickDocument(): Promise<MobileLocalFile | undefined> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: false,
    type: '*/*',
  });
  if (result.canceled) return undefined;
  const asset = result.assets[0];
  return {
    uri: asset.uri,
    name: asset.name,
    mime: asset.mimeType,
    size: asset.size,
    kind: 'file',
    temporary: true,
  };
}

export async function pickImage(): Promise<MobileLocalFile | undefined> {
  let result: ImagePicker.ImagePickerResult | ImagePicker.ImagePickerErrorResult | null = null;
  if (Platform.OS === 'android') {
    result = await ImagePicker.getPendingResultAsync();
    if (result && 'code' in result) {
      throw Object.assign(new Error(result.message), { code: result.code });
    }
  }
  result ??= await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 1 });
  if (result.canceled) return undefined;
  const asset = result.assets[0];
  return {
    uri: asset.uri,
    name: asset.fileName || 'image',
    mime: asset.mimeType ?? undefined,
    size: asset.fileSize ?? undefined,
    kind: 'image',
    temporary: isPickerCacheUri(asset.uri),
  };
}

export function isPickerCacheUri(uri: string) {
  if (!uri.startsWith('file:')) return false;
  try {
    return new URL(uri).pathname.split('/').some((part) => part.toLowerCase() === 'cache' || part.toLowerCase() === 'caches');
  } catch {
    return false;
  }
}
