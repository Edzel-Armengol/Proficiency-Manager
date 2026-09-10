import { useEffect, useState, useCallback } from "react";
import "./App.css";
import { AmazonConnectApp } from "@amazon-connect/app";
import { AgentClient } from "@amazon-connect/contact";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Alert from "@cloudscape-design/components/alert";
import Table from "@cloudscape-design/components/table";
import Header from "@cloudscape-design/components/header";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Modal from "@cloudscape-design/components/modal";
import FormField from "@cloudscape-design/components/form-field";
import { listAttributes, listProficiencies, updateProficiencies, deleteProficiencies } from "./api";

// Proficiency levels 1–5 as Select options
const LEVEL_OPTIONS = [1, 2, 3, 4, 5].map(n => ({
  label: String(n),
  value: n
}));

const connectProvider =
  window.parent !== window
    ? AmazonConnectApp.init({
        onCreate: event => {
          console.info("Proficiency manager app initialized", {
            appInstanceId: event.context.appInstanceId
          });
        },
        onDestroy: () => {
          console.info("Proficiency manager app destroyed");
        }
      }).provider
    : null;

function ProficiencyManager() {
  const [agentArn, setAgentArn] = useState("");
  const [proficiencies, setProficiencies] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(null); // key of the row currently being saved
  const [deletingKey, setDeletingKey] = useState(null);
  const [alertMessage, setAlertMessage] = useState(null);
  const [alertType, setAlertType] = useState("success");

  // Add skill modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [availableAttributes, setAvailableAttributes] = useState([]);
  const [loadingAttributes, setLoadingAttributes] = useState(false);
  const [selectedAttribute, setSelectedAttribute] = useState(null);
  const [selectedValue, setSelectedValue] = useState(null);
  const [selectedLevel, setSelectedLevel] = useState(LEVEL_OPTIONS[0]);
  const [isAdding, setIsAdding] = useState(false);

  // Load agent ARN
  useEffect(() => {
    const agentClient = new AgentClient(connectProvider);

    async function init() {
      try {
        const arn = await agentClient.getARN();
        setAgentArn(arn);
      } catch (error) {
        console.error("Unable to read the current Connect agent", error);
        setAlertMessage("Unable to read the current Amazon Connect agent.");
        setAlertType("error");
        setIsLoading(false);
      }
    }

    void init();
  }, []);

  const fetchProficiencies = useCallback(async (arn) => {
    if (!arn) return;
    setIsLoading(true);
    try {
      const data = await listProficiencies(arn);
      setProficiencies(data.proficiencies || []);
    } catch (error) {
      setAlertMessage(error.message || "Unable to load proficiencies.");
      setAlertType("error");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (agentArn) {
      void fetchProficiencies(agentArn);
    }
  }, [agentArn, fetchProficiencies]);

  // Save a single row immediately when the level dropdown changes
  async function handleLevelChange(attributeName, attributeValue, newLevel) {
    if (!agentArn) return;
    const key = `${attributeName}|${attributeValue}`;
    setSavingKey(key);
    setAlertMessage(null);

    const updated = proficiencies.map(p =>
      p.attributeName === attributeName && p.attributeValue === attributeValue
        ? { ...p, level: newLevel }
        : p
    );

    try {
      const data = await updateProficiencies(agentArn, updated);
      setProficiencies(data.proficiencies || []);
    } catch (error) {
      setAlertMessage(error.message || "Unable to update proficiency level.");
      setAlertType("error");
    } finally {
      setSavingKey(null);
    }
  }

  // ── Add skill modal ────────────────────────────────────────────────────────

  async function handleOpenAddModal() {
    setShowAddModal(true);
    setSelectedAttribute(null);
    setSelectedValue(null);
    setSelectedLevel(LEVEL_OPTIONS[0]);
    setLoadingAttributes(true);
    try {
      const data = await listAttributes();
      setAvailableAttributes(data.attributes || []);
    } catch (error) {
      setAlertMessage(error.message || "Unable to load available skills.");
      setAlertType("error");
      setShowAddModal(false);
    } finally {
      setLoadingAttributes(false);
    }
  }

  const assignedKeys = new Set(
    proficiencies.map(p => `${p.attributeName}|${p.attributeValue}`)
  );

  const attributeOptions = availableAttributes.map(a => ({
    label: a.name,
    value: a.name
  }));

  const valueOptions = selectedAttribute
    ? (availableAttributes.find(a => a.name === selectedAttribute.value)?.values || [])
        .filter(v => !assignedKeys.has(`${selectedAttribute.value}|${v}`))
        .map(v => ({ label: v, value: v }))
    : [];

  async function handleAddSkill() {
    if (!selectedAttribute || !selectedValue || !agentArn) return;
    setIsAdding(true);
    setAlertMessage(null);

    const merged = [
      ...proficiencies.map(p => ({
        attributeName: p.attributeName,
        attributeValue: p.attributeValue,
        level: p.level
      })),
      {
        attributeName: selectedAttribute.value,
        attributeValue: selectedValue.value,
        level: selectedLevel.value
      }
    ];

    try {
      const data = await updateProficiencies(agentArn, merged);
      setProficiencies(data.proficiencies || []);
      setAlertMessage(`Skill "${selectedAttribute.value} — ${selectedValue.value}" added successfully.`);
      setAlertType("success");
      setShowAddModal(false);
    } catch (error) {
      setAlertMessage(error.message || "Unable to add skill.");
      setAlertType("error");
    } finally {
      setIsAdding(false);
    }
  }

  // ── Delete skill ───────────────────────────────────────────────────────────

  async function handleDeleteSkill(attributeName, attributeValue) {
    if (!agentArn) return;
    const key = `${attributeName}|${attributeValue}`;
    setDeletingKey(key);
    setAlertMessage(null);

    try {
      const data = await deleteProficiencies(agentArn, [{ attributeName, attributeValue }]);
      setProficiencies(data.proficiencies || []);
      setAlertMessage(`Skill "${attributeName} — ${attributeValue}" removed.`);
      setAlertType("success");
    } catch (error) {
      setAlertMessage(error.message || "Unable to remove skill.");
      setAlertType("error");
    } finally {
      setDeletingKey(null);
    }
  }

  const isBusy = isLoading || !!savingKey || !!deletingKey;

  return (
    <main className="App">
      {/* Agent status banner */}
      <section className="ProficiencyHeader" aria-label="Agent status">
        <StatusIndicator type={agentArn ? "success" : "pending"}>
          {agentArn ? "Signed-in agent" : "Loading agent…"}
        </StatusIndicator>
      </section>

      {/* Alert */}
      {alertMessage && (
        <Box margin={{ top: "m" }}>
          <Alert
            type={alertType}
            dismissible
            onDismiss={() => setAlertMessage(null)}
          >
            {alertMessage}
          </Alert>
        </Box>
      )}

      {/* Proficiency table */}
      <section className="ProficiencyTable" aria-labelledby="proficiency-table-heading">
        <Table
          header={
            <Header
              id="proficiency-table-heading"
              variant="h3"
              description="Changes to proficiency levels are saved automatically."
              counter={isLoading ? undefined : `(${proficiencies.length})`}
              actions={
                <Button
                  iconName="add-plus"
                  onClick={handleOpenAddModal}
                  disabled={isBusy || !agentArn}
                >
                  Add skill
                </Button>
              }
            >
              My Proficiencies / Skills
            </Header>
          }
          columnDefinitions={[
            {
              id: "skill",
              header: "Predefined Attribute",
              cell: item => (
                <span className="EmphasizedText">{item.attributeName}</span>
              ),
              width: 180
            },
            {
              id: "value",
              header: "Value",
              cell: item => item.attributeValue,
              width: 140
            },
            {
              id: "level",
              header: "Proficiency Level",
              cell: item => (
                <Select
                  selectedOption={{ label: String(item.level), value: item.level }}
                  onChange={({ detail }) =>
                    handleLevelChange(
                      item.attributeName,
                      item.attributeValue,
                      detail.selectedOption.value
                    )
                  }
                  options={LEVEL_OPTIONS}
                  disabled={isBusy}
                  ariaLabel={`Proficiency level for ${item.attributeName} ${item.attributeValue}`}
                />
              ),
              width: 160
            },
            {
              id: "status",
              header: "",
              cell: item =>
                savingKey === `${item.attributeName}|${item.attributeValue}` ? (
                  <StatusIndicator type="loading">Saving…</StatusIndicator>
                ) : (
                  <StatusIndicator type="success">Saved</StatusIndicator>
                ),
              width: 100
            },
            {
              id: "actions",
              header: "",
              cell: item => (
                <Button
                  variant="icon"
                  iconName="remove"
                  ariaLabel={`Remove ${item.attributeName} ${item.attributeValue}`}
                  loading={deletingKey === `${item.attributeName}|${item.attributeValue}`}
                  disabled={isBusy && deletingKey !== `${item.attributeName}|${item.attributeValue}`}
                  onClick={() => handleDeleteSkill(item.attributeName, item.attributeValue)}
                />
              ),
              width: 60
            }
          ]}
          items={proficiencies}
          loading={isLoading}
          loadingText="Loading proficiencies…"
          empty={
            <Box textAlign="center" color="inherit">
              <b>No proficiencies found</b>
              <Box variant="p" color="inherit">
                No proficiencies are assigned to your agent account. Click "Add skill" to get started.
              </Box>
            </Box>
          }
          ariaLabels={{
            tableLabel: "Agent proficiencies table"
          }}
        />
      </section>

      {/* Add Skill Modal */}
      <Modal
        visible={showAddModal}
        onDismiss={() => !isAdding && setShowAddModal(false)}
        header="Add skill"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="link"
                onClick={() => setShowAddModal(false)}
                disabled={isAdding}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleAddSkill}
                loading={isAdding}
                disabled={!selectedAttribute || !selectedValue || isAdding}
              >
                Add
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <FormField label="Predefined Attribute (Skill)">
            <Select
              placeholder={loadingAttributes ? "Loading skills…" : "Select a skill"}
              selectedOption={selectedAttribute}
              onChange={({ detail }) => {
                setSelectedAttribute(detail.selectedOption);
                setSelectedValue(null);
              }}
              options={attributeOptions}
              disabled={loadingAttributes || isAdding}
              statusType={loadingAttributes ? "loading" : "finished"}
              loadingText="Loading available skills…"
              ariaLabel="Select predefined attribute"
            />
          </FormField>

          <FormField label="Value">
            <Select
              placeholder={
                !selectedAttribute
                  ? "Select a skill first"
                  : valueOptions.length === 0
                  ? "All values already assigned"
                  : "Select a value"
              }
              selectedOption={selectedValue}
              onChange={({ detail }) => setSelectedValue(detail.selectedOption)}
              options={valueOptions}
              disabled={!selectedAttribute || valueOptions.length === 0 || isAdding}
              ariaLabel="Select attribute value"
            />
          </FormField>

          <FormField label="Proficiency Level">
            <Select
              selectedOption={selectedLevel}
              onChange={({ detail }) => setSelectedLevel(detail.selectedOption)}
              options={LEVEL_OPTIONS}
              disabled={isAdding}
              ariaLabel="Select proficiency level"
            />
          </FormField>
        </SpaceBetween>
      </Modal>
    </main>
  );
}

function App() {
  if (!connectProvider) {
    return (
      <main className="ConfigurationError">
        <h2>Open this application from Amazon Connect</h2>
        <p>
          The proficiency manager is available inside the Connect Agent
          Workspace.
        </p>
      </main>
    );
  }

  return <ProficiencyManager />;
}

export default App;
