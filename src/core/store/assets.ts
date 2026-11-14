/** The asset rows, for media/. The SQL is sql.ts's; this is the door the media module uses, so it need not import it. */
export { selectAssets, insertAsset, deleteAsset, type AssetRow } from './sql.ts';
