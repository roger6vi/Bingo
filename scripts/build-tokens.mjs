import StyleDictionary from 'style-dictionary';
import { loadContracts, validateTokenContracts, sourcePaths } from './token-contract.mjs';
import { themeConfig } from '../style-dictionary.config.mjs';

const contracts = loadContracts();
validateTokenContracts(contracts);
for (const theme of sourcePaths.themes) {
  const dictionary = new StyleDictionary(themeConfig(contracts.reference, contracts.themes[theme], theme));
  await dictionary.buildAllPlatforms();
}
