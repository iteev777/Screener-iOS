// SPDX-License-Identifier: BUSL-1.1
import { rankCandidates } from "./candidate-analyst.js";

self.onmessage = ({ data }) => {
  const { id, rows, policy, now } = data;
  self.postMessage({ id, result: rankCandidates(rows, policy, now) });
};
