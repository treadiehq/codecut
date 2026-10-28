import {
  commentScanOptionsForPath,
  scanCommentLines,
  type CommentLine,
} from "./comments.js";

export const DEFAULT_MAX_COMMENT_PERCENTAGE = 25;
export const DEFAULT_MIN_ADDED_LINES_FOR_COMMENT_PERCENTAGE = 20;

export type AddedCommentStats = {
  path: string;
  sourceLines: number;
  commentLines: number;
};

export type CommentDensity = {
  sourceLines: number;
  commentLines: number;
};

export function measureAddedComments(
  filePath: string,
  lines: CommentLine[],
): AddedCommentStats {
  return {
    path: filePath,
    sourceLines: lines.filter((line) => line.text.trim().length > 0).length,
    commentLines: scanCommentLines(lines, commentScanOptionsForPath(filePath))
      .length,
  };
}

export function aggregateCommentStats(
  stats: AddedCommentStats[],
): CommentDensity {
  return stats.reduce<CommentDensity>(
    (total, item) => ({
      sourceLines: total.sourceLines + item.sourceLines,
      commentLines: total.commentLines + item.commentLines,
    }),
    { sourceLines: 0, commentLines: 0 },
  );
}

export function exceedsCommentPercentage(
  density: CommentDensity,
  maximumPercentage: number | undefined,
  minimumSourceLines: number,
): boolean {
  return (
    maximumPercentage !== undefined &&
    density.sourceLines >= minimumSourceLines &&
    density.commentLines * 100 > maximumPercentage * density.sourceLines
  );
}

export function formatCommentPercentage(density: CommentDensity): string {
  if (density.sourceLines === 0) {
    return "0%";
  }
  const percentage = (density.commentLines * 100) / density.sourceLines;
  return `${Number(percentage.toFixed(1))}%`;
}
