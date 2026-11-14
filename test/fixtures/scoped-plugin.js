// A host's editor plugin that applies only to one field: `:mention[ada]` is a chip in `note.body` and plain text elsewhere.
import mention from './mention-plugin.js';

export default function (builder, context) {
  if (context.type !== 'note' || context.field !== 'body') return;
  mention(builder);
}
