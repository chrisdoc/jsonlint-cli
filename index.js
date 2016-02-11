#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const minimist = require('minimist');
const rcNodeBack = require('cli-rc');
const globby = require('globby');
const parser = require('jsonlint').parser;
const denodeify = require('denodeify');
const jjv = require('jjv');
const request = require('sync-request');
const mkdirp = require('mkdirp');
var memoize = require('lodash.memoize');

const read = denodeify(fs.readFile);
const rc = denodeify(rcNodeBack);

const pkg = require('./package.json');

const defaults = {
	ignore: ['node_modules/**/*'],
	validate: null,
	indent: '  ',
	env: 'json-schema-draft-04',
	quiet: false,
	pretty: false
};

const aliases = {
	ignore: 'i',
	validate: 's',
	indent: 'w',
	env: 'e',
	quiet: 'q',
	pretty: 'p'
};

const descriptions = {
	ignore: 'glob pattern to exclude from linting',
	validate: 'uri to schema to use for validation',
	indent: 'whitespace to use for pretty printing',
	env: 'json schema env to use for validation',
	quiet: 'surpress all output',
	pretty: 'pretty-print the input'
};

function repeat(s, count) {
	return new Array(count + 1).join(s);
}
function formatJson(source, indent) {
	var i = 0; 	// eslint-disable-line no-var
	var il = 0;	// eslint-disable-line no-var
	var tab = (typeof indent === 'undefined') ? '		' : indent;	// eslint-disable-line no-var
	var newJson = '';	// eslint-disable-line no-var
	var indentLevel = 0;	// eslint-disable-line no-var
	var inString = false;	// eslint-disable-line no-var
	var currentChar = null;	// eslint-disable-line no-var

	for (i = 0, il = source.length; i < il; i += 1) {
		currentChar = source.charAt(i);

		switch (currentChar) {
			case '{':
			case '[':
				if (inString) {
					newJson += currentChar;
				} else {
					newJson += currentChar + '\n' + repeat(tab, indentLevel + 1); // eslint-disable-line prefer-template
					indentLevel += 1;
				}
				break;
			case '}':
			case ']':
				if (inString) {
					newJson += currentChar;
				} else {
					indentLevel -= 1;
					newJson += '\n' + repeat(tab, indentLevel) + currentChar; // eslint-disable-line prefer-template
				}
				break;
			case ',':
				if (inString) {
					newJson += currentChar;
				} else {
					newJson += ',\n' + repeat(tab, indentLevel); // eslint-disable-line prefer-template
				}
				break;
			case ':':
				if (inString) {
					newJson += currentChar;
				} else {
					newJson += ': ';
				}
				break;
			case ' ':
			case '\n':
			case '\t':
				if (inString) {
					newJson += currentChar;
				}
				break;
			case '"':
				if (i > 0 && source.charAt(i - 1) !== '\\') {
					inString = !inString;
				}
				newJson += currentChar;
				break;
			default:
				newJson += currentChar;
				break;
		}
	}
	return newJson;
}

function sort(o) {
	if (Array.isArray(o)) {
		return o.map(sort);
	} else if (Object.prototype.toString.call(o) !== '[object Object]') {
		return o;
	}

	const sorted = {};
	const a = [];
	var key; // eslint-disable-line no-var

	for (key in o) {
		if (o.hasOwnProperty(key)) {
			a.push(key);
		}
	}

	a.sort();

	for (key = 0; key < a.length; key++) {
		sorted[a[key]] = sort(o[a[key]]);
	}

	return sorted;
}

const lex = {
	type(key, value) {
		return `"${key}" must be of type "${value}"`;
	},
	minLength(key, value, ruleName, ruleValue) {
		return `"${key}" must be at least "${ruleValue}" characters`;
	},
	maxLength(key, value, ruleName, ruleValue) {
		return `"${key}" may be at most "${ruleValue}" characters`;
	},
	minProperties(key, value, ruleName, ruleValue) {
		return `"${key}" must hold at least "${ruleValue}" properties`;
	},
	maxProperties(key, value, ruleName, ruleValue) {
		return `"${key}" may hold at most "${ruleValue}" properties`;
	},
	patternProperties(key, value, ruleName, ruleValue) {
		return `"${key}" must hold "${ruleValue}" properties`;
	},
	minItems(key, value, ruleName, ruleValue) {
		return `"${key}" must have at leat "${ruleValue}" items`;
	},
	maxItems(key, value, ruleName, ruleValue) {
		return `"${key}" may have at most "${ruleValue}" items`;
	},
	required(key, _, name) {
		return `"${key}" is ${name} but unset`;
	},
	additional(key, value, name) {
		return `"${key}" is not allowed as ${name} key	`;
	},
	fallback(key, value, ruleName, ruleValue, prop) {
		const ruleValueString = typeof ruleValue === 'string' ? JSON.stringify(ruleValue) : ruleValue;
		return `"${key}" does not meet rule "${ruleName}=${ruleValueString}" - ${prop.description}`;
	}
};

function schemaError(error, schema) {
	return Object.keys(error.validation)
		.reduce((messages, key) => {
			const validation = error.validation[key];
			const names = Object.keys(validation);

			return messages.concat(
				names
					.map(name => lex[name] || lex.fallback)
					.map((formatter, index) => {
						const name = names[index];
						const props = schema.properties || {};
						const prop = props[key] || {};
						return formatter(
							key,
							validation[name],
							name,
							prop[name] || '',
							prop
						);
					})
			);
		}, []);
}

function getSchemaCacheId(uri) {
	const sum = crypto.createHash('md5');
	sum.update(uri);
	return sum.digest('hex');
}

function readSchemaCache(uri) {
	const id = getSchemaCacheId(uri);
	const tmp = path.resolve(__dirname, '.tmp', `${id}.json`);

	try {
		return fs.readFileSync(tmp);
	} catch (error) {
		return null;
	}
}

function writeSchemaCache(uri, schema) {
	const id = getSchemaCacheId(uri);
	const tmp = path.resolve(__dirname, '.tmp', `${id}.json`);

	try {
		mkdirp.sync(path.dirname(tmp));
		return fs.writeFileSync(tmp, schema);
	} catch (error) {
		return null;
	}
}

function getSchema(uri) {
	const parsed = url.parse(uri);

	if (parsed.protocol && parsed.host) {
		const buffer = readSchemaCache(uri);
		const response = buffer ? buffer.toString('utf-8') : request('GET', uri).getBody();
		const data = JSON.parse(response);
		writeSchemaCache(uri, response);
		return data;
	}

	return require(uri);
}

const obtainSchema = memoize(getSchema);

function lint(source, sourcePath, settings) {
	return new Promise((resolve, reject) => {
		const absSourcePath = sourcePath ? path.resolve(sourcePath) : null;

		try {
			const parsed = settings.source ?
				sort(parser.parse(source)) :
				parser.parse(source);

			if (settings.pretty && !settings.quiet) {
				console.log(formatJson(source, settings.indent));
			}

			if (settings.validate) {
				const environment = jjv(settings.env);
				const schema = obtainSchema(settings.validate);
				environment.addSchema('default', schema);
				const errors = environment.validate('default', parsed);
				if (errors) {
					const jsonLintError = new Error([`"${absSourcePath}" fails against schema "${settings.validate}"`]
						.concat(schemaError(errors, schema)
							.filter(Boolean)
							.map(message => `		${message}`)
						).join('\n'));

					jsonLintError.type = 'jsonlint';
					throw jsonLintError;
				}
			}
		} catch (error) {
			error.message = settings.quiet ? null : `${absSourcePath} ${error.message}`;
			error.file = absSourcePath;
			error.type = 'jsonlint';
			reject(error);
		}
	});
}

function readStdin() {
	return new Promise(resolve => {
		const source = [];
		const stdin = process.openStdin();
		stdin.setEncoding('utf8');
		stdin.on('data', chunk => {
			source.push(chunk.toString('utf8'));
		});
		stdin.on('end', () => {
			resolve(source.join(''));
		});
	});
}

function getSettings(options, path) {
	const loaders = [
		{
			name: '.jsonlintrc',
			path: [path],
			append: true
		},
		{
			name: '.jsonlintignore',
			path: [path],
			type: 'ini',
			append: true
		}
	].map(loader => {
		return rc(loader)
			.catch(error => {
				setTimeout(() => {
					throw error;
				});
			});
	});

	return Promise.all(loaders)
		.then(results => {
			const configuration = results[0];
			const ignore = Object.keys(results[1]);
			return Object.assign({}, defaults, configuration, options, {
				ignore
			});
		});
}

function execute(settings) {
	const files = settings._ || [];
	const ignored = settings.ignore.map(rule => `!${rule}`);
	const glob = files.concat(ignored);

	// read from stdin if no files are given
	if (files.length === 0) {
		return readStdin()
			.then(content => {
				return lint(content, null, settings);
			});
	}

	// read the glob if files are given
	return globby(glob).then(paths => {
		if (paths.length > 0) {
			return Promise.all(
				paths
					.map(file => {
						return Promise.all([
							read(file)
							.then(buffer => {
								return {
									content: buffer.toString('utf-8'),
									path: file
								};
							}),
							getSettings(settings, file)
						]);
					})
					.map(payload => {
						return payload
							.then(results => {
								const shipment = results[0];
								const fileConfiguration = results[1];

								return lint(
									shipment.content.toString('utf-8'),
									shipment.path,
									fileConfiguration
								);
							});
					})
			);
		}
	});
}

function printFlags() {
	const flags = Object.keys(defaults)
		.map(key => {
			return [`--${aliases[key]}, --${key}`, `${descriptions[key]}, defaults to: "${defaults[key]}"`];
		});

	const lines = [
		[`--h, --help`, `show this help`],
		[`--v, --version`, `show jsonlint-cli version`]
	].concat(flags);

	const longestKeyLine = lines.sort((a, b) => b[0].length - a[0].length)[0];
	const longest = longestKeyLine[0].length;

	return lines
		.map(line => `${line[0]}${' '.repeat(4 + longest - line[0].length)}${line[1]}`)
		.join('\n');
}

function help() {
	console.log(`
${pkg.name} [options] [file] - ${pkg.description}

${printFlags()}
	`);
}

function main(options) {
	if (options.help) {
		help();
		return Promise.resolve();
	}

	if (options.version) {
		console.log(pkg.version);
		return Promise.resolve();
	}

	return getSettings(options, process.cwd())
		.then(execute);
}

// parse cli flags
const args = minimist(process.argv.slice(2));

// start the main function
main(args)
	.catch(error => {
		if (error.type === 'jsonlint') {
			if (error.message !== null) {
				console.log(error.message);
			}
			process.exit(1);
		} else {
			setTimeout(() => {
				throw error;
			});
		}
	});
