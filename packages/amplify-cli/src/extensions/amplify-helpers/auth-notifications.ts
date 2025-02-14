import { $TSAny, $TSContext, exitOnNextTick, FeatureFlags, pathManager, stateManager } from 'amplify-cli-core';
import { printer, prompter } from 'amplify-prompts';
import fs from 'fs-extra';
import { DirectiveNode, DocumentNode, FieldDefinitionNode, FieldNode, parse } from 'graphql';
import { collectDirectivesByType, collectDirectivesByTypeNames, readProjectConfiguration } from 'graphql-transformer-core';
import path from 'path';
import _ from 'lodash';

async function setNotificationFlag(projectPath: string, flagName: string, value: boolean): Promise<void> {
  await FeatureFlags.ensureFeatureFlag('graphqltransformer', flagName);

  let config = stateManager.getCLIJSON(projectPath, undefined, {
    throwIfNotExist: false,
    preserveComments: true,
  });

  if (config) {
    config.features.graphqltransformer[flagName] = value;
    stateManager.setCLIJSON(projectPath, config);
    await FeatureFlags.reloadValues();
  }
}

export async function notifyFieldAuthSecurityChange(context: $TSContext): Promise<boolean> {
  const flagName = 'showfieldauthnotification';
  const dontShowNotification = !FeatureFlags.getBoolean(`graphqltransformer.${flagName}`);

  if (dontShowNotification) return false;

  const projectPath = pathManager.findProjectRoot() ?? process.cwd();
  const apiResourceDir = await getApiResourceDir();
  if (!apiResourceDir) {
    await setNotificationFlag(projectPath, flagName, false);
    return false;
  }

  const project = await readProjectConfiguration(apiResourceDir);
  const directiveMap = collectDirectivesByType(project.schema);
  const doc: DocumentNode = parse(project.schema);
  const fieldDirectives: Set<string> = hasFieldAuthDirectives(doc);

  let schemaModified = false;
  if (displayAuthNotification(directiveMap, fieldDirectives)) {
    printer.blankLine();
    const continueChange = await prompter.yesOrNo(
      `This version of Amplify CLI introduces additional security enhancements for your GraphQL API. ` +
        `The changes are applied automatically with this deployment. This change won't impact your client code. Continue?`,
    );

    if (!continueChange) {
      await context.usageData.emitSuccess();
      exitOnNextTick(0);
    }
    modifyGraphQLSchema(apiResourceDir);
    schemaModified = true;
  }

  await setNotificationFlag(projectPath, flagName, false);
  return schemaModified;
}

export async function loadResolvers(apiResourceDirectory: string): Promise<Record<string, string>> {
  const resolvers = {};

  const resolverDirectory = path.join(apiResourceDirectory, 'build', 'resolvers');
  const resolverDirExists = fs.existsSync(resolverDirectory);
  if (resolverDirExists) {
    const resolverFiles = await fs.readdir(resolverDirectory);
    for (const resolverFile of resolverFiles) {
      if (resolverFile.indexOf('.') === 0) {
        continue;
      }
      const resolverFilePath = path.join(resolverDirectory, resolverFile);
      resolvers[resolverFile] = await fs.readFile(resolverFilePath, 'utf8');
    }
  }

  return resolvers;
}

export async function notifyListQuerySecurityChange(context: $TSContext): Promise<boolean> {
  const apiResourceDir = await getApiResourceDir();
  if (!apiResourceDir) {
    return false;
  }

  const project = await readProjectConfiguration(apiResourceDir);
  const resolvers = await loadResolvers(apiResourceDir);

  const resolversToCheck = Object.entries(resolvers)
    .filter(([resolverFileName, _]) => resolverFileName.startsWith('Query.list') && resolverFileName.endsWith('.req.vtl'))
    .map(([_, resolverCode]) => resolverCode);
  const listQueryPattern = /#set\( \$filterExpression = \$util\.parseJson\(\$util\.transform\.toDynamoDBFilterExpression\(\$filter\)\) \)\s*(?!\s*#if\( \$util\.isNullOrEmpty\(\$filterExpression\) \))/gm;
  const resolversToSecure = resolversToCheck.filter(resolver => listQueryPattern.test(resolver));
  if (resolversToSecure.length === 0) {
    return false;
  }

  const doc: DocumentNode = parse(project.schema);

  let schemaModified = false;
  if (hasV2AuthDirectives(doc)) {
    printer.blankLine();
    const continueChange = await prompter.yesOrNo(
      `This version of Amplify CLI introduces additional security enhancements for your GraphQL API. ` +
        `The changes are applied automatically with this deployment. This change won't impact your client code. Continue?`,
    );

    if (!continueChange) {
      await context.usageData.emitSuccess();
      exitOnNextTick(0);
    }

    modifyGraphQLSchema(apiResourceDir);
    schemaModified = true;
  }

  return schemaModified;
}

async function containsGraphQLApi(): Promise<boolean> {
  const projectPath = pathManager.findProjectRoot() ?? process.cwd();
  const meta = stateManager.getMeta(projectPath);

  const apiNames = Object.entries(meta?.api || {})
    .filter(([_, apiResource]) => (apiResource as $TSAny).service === 'AppSync')
    .map(([name]) => name);

  const doesNotHaveGqlApi = apiNames.length < 1;

  if (doesNotHaveGqlApi) {
    return false;
  }

  const apiName = apiNames[0];
  const apiResourceDir = pathManager.getResourceDirectoryPath(projectPath, 'api', apiName);

  if (!fs.existsSync(apiResourceDir)) {
    return false;
  }

  return true;
}

async function getApiResourceDir(): Promise<string | undefined> {
  const hasGraphQLApi = await containsGraphQLApi();
  if (!hasGraphQLApi) {
    return undefined;
  }

  const projectPath = pathManager.findProjectRoot() ?? process.cwd();
  const meta = stateManager.getMeta(projectPath);

  const apiNames = Object.entries(meta?.api || {})
    .filter(([_, apiResource]) => (apiResource as $TSAny).service === 'AppSync')
    .map(([name]) => name);

  const apiName = apiNames[0];
  const apiResourceDir = pathManager.getResourceDirectoryPath(projectPath, 'api', apiName);

  return apiResourceDir;
}

async function modifyGraphQLSchema(apiResourceDir: string): Promise<void> {
  const schemaFilePath = path.join(apiResourceDir, 'schema.graphql');
  const schemaDirectoryPath = path.join(apiResourceDir, 'schema');
  const schemaFileExists = fs.existsSync(schemaFilePath);
  const schemaDirectoryExists = fs.existsSync(schemaDirectoryPath);

  if (schemaFileExists) {
    fs.appendFile(schemaFilePath, ' ');
  } else if (schemaDirectoryExists) {
    await modifyGraphQLSchemaDirectory(schemaDirectoryPath);
  }
}

async function modifyGraphQLSchemaDirectory(schemaDirectoryPath: string): Promise<boolean> {
  const files = await fs.readdir(schemaDirectoryPath);

  for (const fileName of files) {
    const isHiddenFile = fileName.indexOf('.') === 0;

    if (isHiddenFile) {
      continue;
    }

    const fullPath = path.join(schemaDirectoryPath, fileName);
    const stats = await fs.lstat(fullPath);

    if (stats.isDirectory() && (await modifyGraphQLSchemaDirectory(fullPath))) {
      return true;
    } else if (stats.isFile()) {
      fs.appendFile(fullPath, ' ');
      return true;
    }
  }

  return false;
}

export function displayAuthNotification(directiveMap: any, fieldDirectives: Set<string>): boolean {
  const usesTransformerV2 = FeatureFlags.getNumber('graphqltransformer.transformerversion') === 2;
  const schemaHasValues = Object.keys(directiveMap).some((typeName: string) => {
    const typeObj = directiveMap[typeName];
    const modelDirective = typeObj.find((dir: DirectiveNode) => dir.name.value === 'model');

    const subscriptionOff: boolean = (modelDirective?.arguments || []).some((arg: any) => {
      if (arg.name.value === 'subscriptions') {
        const subscriptionNull = arg.value.kind === 'NullValue';
        const levelFieldOffOrNull = arg.value?.fields?.some(({ name, value }) => {
          return name.value === 'level' && (value.value === 'off' || value.kind === 'NullValue');
        });

        return levelFieldOffOrNull || subscriptionNull;
      }
    });

    return subscriptionOff && fieldDirectives.has(typeName);
  });

  return schemaHasValues && usesTransformerV2;
}

export function hasFieldAuthDirectives(doc: DocumentNode): Set<string> {
  const haveFieldAuthDir: Set<string> = new Set();

  doc.definitions?.forEach((def: any) => {
    const withAuth: FieldNode[] = (def.fields || []).filter((field: FieldDefinitionNode) => {
      const nonNullable = field.type.kind === 'NonNullType';
      const hasAuth = field.directives?.some(dir => dir.name.value === 'auth');
      return hasAuth && nonNullable;
    });

    if (withAuth.length > 0) {
      haveFieldAuthDir.add(def.name.value);
    }
  });

  return haveFieldAuthDir;
}

export function hasV2AuthDirectives(doc: DocumentNode): boolean {
  let containsAuthDir = false;
  const usesTransformerV2 = FeatureFlags.getNumber('graphqltransformer.transformerversion') === 2;

  doc.definitions?.forEach((def: any) => {
    if (def.directives?.some(dir => dir.name.value === 'auth')) {
      containsAuthDir = true;
    }
  });

  return containsAuthDir && usesTransformerV2;
}

export async function notifySecurityEnhancement(context) {
  if (FeatureFlags.getBoolean('graphqltransformer.securityEnhancementNotification')) {
    const projectPath = pathManager.findProjectRoot() ?? process.cwd();
    const meta = stateManager.getMeta();

    const apiNames = Object.entries(meta?.api || {})
      .filter(([_, apiResource]) => (apiResource as $TSAny).service === 'AppSync')
      .map(([name]) => name);

    if (apiNames.length !== 1) {
      await setNotificationFlag(projectPath, 'securityEnhancementNotification', false);
      return;
    }

    const apiName = apiNames[0];

    const apiResourceDir = pathManager.getResourceDirectoryPath(projectPath, 'api', apiName);

    if (!fs.existsSync(apiResourceDir)) {
      await setNotificationFlag(projectPath, 'securityEnhancementNotification', false);
      return;
    }

    const project = await readProjectConfiguration(apiResourceDir);

    const directiveMap = collectDirectivesByTypeNames(project.schema);
    const notifyAuthWithKey = Object.keys(directiveMap.types).some(
      type => directiveMap.types[type].includes('auth') && directiveMap.types[type].includes('primaryKey'),
    );

    if (meta?.auth && notifyAuthWithKey) {
      printer.blankLine();
      const shouldContinue = await prompter.yesOrNo(
        `This version of Amplify CLI introduces additional security enhancements for your GraphQL API. @auth authorization rules applied on primary keys and indexes are scoped down further. The changes are applied automatically with this deployment. This change won't impact your client code. Continue`,
      );

      if (!shouldContinue) {
        await context.usageData.emitSuccess();
        exitOnNextTick(0);
      }

      await modifyGraphQLSchema(apiResourceDir);

      await setNotificationFlag(projectPath, 'securityEnhancementNotification', false);
    } else {
      await setNotificationFlag(projectPath, 'securityEnhancementNotification', false);
    }
  }
}
